// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KismetGiftPool, IFixedPriceSaleStrategy} from "../src/KismetGiftPool.sol";

// ------------------------------------------------------------------- mocks

/// @dev Stands in for Zora's FixedPriceSaleStrategy: per-(collection,tokenId)
///      SalesConfig rows, returned by the same `sale()` view the pool reads.
contract MockFPSS {
    mapping(address => mapping(uint256 => IFixedPriceSaleStrategy.SalesConfig)) internal rows;

    function set(
        address collection,
        uint256 tokenId,
        uint96 pricePerToken,
        uint64 saleEnd
    ) external {
        rows[collection][tokenId] = IFixedPriceSaleStrategy.SalesConfig({
            saleStart: 0,
            saleEnd: saleEnd,
            maxTokensPerAddress: 0,
            pricePerToken: pricePerToken,
            fundsRecipient: address(0xFEE)
        });
    }

    function sale(address collection, uint256 tokenId)
        external
        view
        returns (IFixedPriceSaleStrategy.SalesConfig memory)
    {
        return rows[collection][tokenId];
    }
}

/// @dev Stands in for a Zora 1155 collection. Mirrors the property the pool
///      leans on: the mint path enforces a STRICT total value (price + fee),
///      reverting on any mismatch — a later re-price flips expectedValue and
///      execute() must revert in full.
contract Mock1155 {
    error WrongValueSent();

    uint256 public mintFee;
    uint256 public expectedValue;

    // last-mint recording
    address public lastMinter;
    uint256 public lastTokenId;
    uint256 public lastQuantity;
    address public lastRewardRecipient;
    address public lastMintTo;
    uint256 public mintCount;

    constructor(uint256 mintFee_) {
        mintFee = mintFee_;
    }

    function setExpectedValue(uint256 v) external {
        expectedValue = v;
    }

    function mint(
        address minter,
        uint256 tokenId,
        uint256 quantity,
        address[] calldata rewardsRecipients,
        bytes calldata minterArguments
    ) external payable {
        if (msg.value != expectedValue) revert WrongValueSent();
        lastMinter = minter;
        lastTokenId = tokenId;
        lastQuantity = quantity;
        lastRewardRecipient = rewardsRecipients[0];
        (lastMintTo,) = abi.decode(minterArguments, (address, string));
        mintCount++;
    }
}

/// @dev Contributes, then on the ETH it receives back tries to re-enter the
///      pool. The inner call's failure is swallowed so the outer transfer
///      still succeeds — the test then asserts nothing was double-paid.
contract ReentrantPatron {
    KismetGiftPool public pool;
    uint256 public poolId;
    bytes4 public attackSelector; // withdraw(uint256) or contribute(uint256)
    uint256 public reentryAttempts;
    bool public innerCallSucceeded;

    constructor(KismetGiftPool pool_) {
        pool = pool_;
    }

    function arm(uint256 poolId_, bytes4 selector) external {
        poolId = poolId_;
        attackSelector = selector;
    }

    function contribute(uint256 poolId_) external payable {
        pool.contribute{value: msg.value}(poolId_);
    }

    function withdraw(uint256 poolId_) external {
        pool.withdraw(poolId_);
    }

    receive() external payable {
        if (attackSelector != bytes4(0)) {
            reentryAttempts++;
            bytes4 sel = attackSelector;
            attackSelector = bytes4(0); // one attempt, no infinite loop
            (bool ok,) = address(pool).call{value: 0}(abi.encodeWithSelector(sel, poolId));
            innerCallSucceeded = ok;
        }
    }
}

/// @dev A patron whose wallet refuses ETH — exercises RefundFailed and
///      WithdrawFailed.
contract EthRejector {
    KismetGiftPool public pool;

    constructor(KismetGiftPool pool_) {
        pool = pool_;
    }

    function contribute(uint256 poolId) external payable {
        pool.contribute{value: msg.value}(poolId);
    }

    function withdraw(uint256 poolId) external {
        pool.withdraw(poolId);
    }

    receive() external payable {
        revert("no");
    }
}

// -------------------------------------------------------------------- tests

contract KismetGiftPoolTest is Test {
    MockFPSS internal fpss;
    Mock1155 internal collection;
    KismetGiftPool internal pool;

    address internal constant REFERRAL = address(0xCAFE);
    address internal artist = makeAddr("artist");
    address internal patronA = makeAddr("patronA");
    address internal patronB = makeAddr("patronB");
    address internal rando = makeAddr("rando");

    uint96 internal constant PRICE = 0.03 ether;
    uint256 internal constant FEE = 0.000111 ether;
    uint256 internal constant GOAL = uint256(PRICE) + FEE;
    uint256 internal constant TOKEN_ID = 7;

    function setUp() public {
        fpss = new MockFPSS();
        collection = new Mock1155(FEE);
        pool = new KismetGiftPool(address(fpss), REFERRAL, address(collection));

        fpss.set(address(collection), TOKEN_ID, PRICE, uint64(block.timestamp + 30 days));
        collection.setExpectedValue(GOAL);

        vm.deal(artist, 10 ether);
        vm.deal(patronA, 10 ether);
        vm.deal(patronB, 10 ether);
        vm.deal(rando, 10 ether);
    }

    function _createPool() internal returns (uint256 poolId) {
        vm.prank(artist);
        poolId = pool.create(TOKEN_ID, artist);
    }

    function _raised(uint256 poolId) internal view returns (uint256 raised) {
        (,,, raised,) = pool.pools(poolId);
    }

    function _executed(uint256 poolId) internal view returns (bool executed) {
        (,,,, executed) = pool.pools(poolId);
    }

    // ------------------------------------------------------------- create

    function test_create_derivesGoalFromChain() public {
        uint256 poolId = _createPool();
        (uint256 t, address r, uint256 goal, uint256 raised, bool executed) = pool.pools(poolId);
        assertEq(t, TOKEN_ID);
        assertEq(r, artist);
        assertEq(goal, GOAL);
        assertEq(raised, 0);
        assertFalse(executed);
        assertEq(pool.nextPoolId(), 1);
    }

    function test_collection_isImmutable() public view {
        // The safety keystone: the pool mints only from the address baked in
        // at deploy — there is no per-pool or caller-supplied collection.
        assertEq(pool.collection(), address(collection));
    }

    function test_create_revertsOnZeroRecipient() public {
        vm.expectRevert(KismetGiftPool.ZeroRecipient.selector);
        pool.create(TOKEN_ID, address(0));
    }

    function test_create_revertsWhenNoSaleRow() public {
        // tokenId 99 was never configured → saleEnd == 0
        vm.expectRevert(KismetGiftPool.SaleNotConfigured.selector);
        pool.create(99, artist);
    }

    function test_create_revertsWhenSaleAlreadyEnded() public {
        // Warp past a configured sale's end: a closed mint can never execute,
        // so opening a pool for it is refused (no fundable-but-dead pools).
        fpss.set(address(collection), 5, PRICE, uint64(block.timestamp + 1 days));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(KismetGiftPool.SaleEnded.selector);
        pool.create(5, artist);
    }

    function test_create_revertsWhenGoalExceedsCeiling() public {
        fpss.set(address(collection), 8, 6 ether, uint64(block.timestamp + 1 days));
        vm.expectRevert(KismetGiftPool.GoalTooLarge.selector);
        pool.create(8, artist);
    }

    function test_create_revertsOnZeroGoal() public {
        // A free mint (price 0, fee 0) on the pool's own collection.
        Mock1155 freeCollection = new Mock1155(0);
        KismetGiftPool freePool =
            new KismetGiftPool(address(fpss), REFERRAL, address(freeCollection));
        fpss.set(address(freeCollection), 1, 0, uint64(block.timestamp + 1 days));
        vm.expectRevert(KismetGiftPool.ZeroGoal.selector);
        freePool.create(1, artist);
    }

    function test_create_ignoresSaleOnAnotherCollection() public {
        // An attacker registers a sale for their OWN contract on the shared
        // FPSS and tries to have this pool mint from it. There is no collection
        // parameter — create only ever reads THIS pool's immutable collection,
        // which has no sale row for the attacker's chosen tokenId shape. The
        // attacker's registration is unreachable: funds can never be routed
        // into a contract the pool's deployer didn't vet.
        Mock1155 evil = new Mock1155(0);
        fpss.set(address(evil), 1234, PRICE, uint64(block.timestamp + 1 days));
        // tokenId 1234 has no sale on the real (immutable) collection.
        vm.expectRevert(KismetGiftPool.SaleNotConfigured.selector);
        pool.create(1234, artist);
        // And the evil collection never receives a mint from this pool.
        assertEq(evil.mintCount(), 0);
    }

    // --------------------------------------------------------- contribute

    function test_contribute_records() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);
        assertEq(_raised(poolId), 0.01 ether);
        assertEq(pool.contributions(poolId, patronA), 0.01 ether);
        assertEq(address(pool).balance, 0.01 ether);
    }

    function test_contribute_clampsAndRefundsExcess() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.02 ether}(poolId);

        uint256 before = patronB.balance;
        vm.prank(patronB);
        pool.contribute{value: 1 ether}(poolId); // way over the remainder

        uint256 remainder = GOAL - 0.02 ether;
        assertEq(_raised(poolId), GOAL);
        assertEq(pool.contributions(poolId, patronB), remainder);
        assertEq(before - patronB.balance, remainder); // excess came straight back
        assertEq(address(pool).balance, GOAL);
    }

    function test_contribute_enforcesDustFloor() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        vm.expectRevert(KismetGiftPool.BelowMinimum.selector);
        pool.contribute{value: 0.00009 ether}(poolId);
    }

    function test_contribute_zeroValueReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        vm.expectRevert(KismetGiftPool.BelowMinimum.selector);
        pool.contribute{value: 0}(poolId);
    }

    function test_contribute_dustWaivedOnExactFill() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL - 1 wei}(poolId);

        // 1 wei is far below the floor, but it exactly fills the pool.
        vm.prank(patronB);
        pool.contribute{value: 1 wei}(poolId);
        assertEq(_raised(poolId), GOAL);
    }

    function test_contribute_dustAboveRemainderStillWaived() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL - 1 wei}(poolId);

        // Overshooting dust clamps to the 1-wei remainder and is accepted.
        vm.prank(patronB);
        pool.contribute{value: 0.00005 ether}(poolId);
        assertEq(_raised(poolId), GOAL);
        assertEq(pool.contributions(poolId, patronB), 1 wei);
    }

    function test_contribute_fullPoolReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);

        vm.prank(patronB);
        vm.expectRevert(KismetGiftPool.PoolFull.selector);
        pool.contribute{value: 0.01 ether}(poolId);
    }

    function test_contribute_unknownPoolReverts() public {
        vm.prank(patronA);
        vm.expectRevert(KismetGiftPool.NoSuchPool.selector);
        pool.contribute{value: 0.01 ether}(42);
    }

    function test_contribute_afterExecuteReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);
        pool.execute(poolId);

        vm.prank(patronB);
        vm.expectRevert(KismetGiftPool.PoolAlreadyExecuted.selector);
        pool.contribute{value: 0.01 ether}(poolId);
    }

    function test_contribute_refundToRejectorReverts() public {
        uint256 poolId = _createPool();
        EthRejector rejector = new EthRejector(pool);
        vm.deal(address(rejector), 1 ether);

        vm.prank(patronA);
        pool.contribute{value: 0.02 ether}(poolId);

        // Rejector overshoots → refund path → its receive() reverts.
        vm.expectRevert(KismetGiftPool.RefundFailed.selector);
        rejector.contribute{value: 1 ether}(poolId);
    }

    // ----------------------------------------------------------- withdraw

    function test_withdraw_fullAmountAnytime() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);
        vm.prank(patronA);
        pool.contribute{value: 0.005 ether}(poolId);

        uint256 before = patronA.balance;
        vm.prank(patronA);
        pool.withdraw(poolId);

        assertEq(patronA.balance - before, 0.015 ether);
        assertEq(pool.contributions(poolId, patronA), 0);
        assertEq(_raised(poolId), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_withdraw_nothingToWithdrawReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        vm.expectRevert(KismetGiftPool.NothingToWithdraw.selector);
        pool.withdraw(poolId);
    }

    function test_withdraw_afterExecuteReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);
        pool.execute(poolId);

        vm.prank(patronA);
        vm.expectRevert(KismetGiftPool.PoolAlreadyExecuted.selector);
        pool.withdraw(poolId);
    }

    function test_withdraw_dropsPoolBelowGoal() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);

        // The at-goal race, withdraw-first ordering: pool drops below goal
        // and execute reverts — pool simply continues.
        vm.prank(patronA);
        pool.withdraw(poolId);

        vm.expectRevert(KismetGiftPool.PoolNotFull.selector);
        pool.execute(poolId);

        // ...and can refill and execute later.
        vm.prank(patronB);
        pool.contribute{value: GOAL}(poolId);
        pool.execute(poolId);
        assertEq(collection.mintCount(), 1);
    }

    function test_withdraw_toRejectorReverts() public {
        uint256 poolId = _createPool();
        EthRejector rejector = new EthRejector(pool);
        vm.deal(address(rejector), 1 ether);
        rejector.contribute{value: 0.01 ether}(poolId);

        vm.expectRevert(KismetGiftPool.WithdrawFailed.selector);
        rejector.withdraw(poolId);
        // Nothing lost: the whole tx reverted, contribution intact.
        assertEq(pool.contributions(poolId, address(rejector)), 0.01 ether);
    }

    // ------------------------------------------------------------ execute

    function test_execute_mintsToRecipientWithExactValue() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);
        vm.prank(patronB);
        pool.contribute{value: GOAL - 0.01 ether}(poolId);

        vm.prank(rando); // anyone may execute
        pool.execute(poolId);

        assertTrue(_executed(poolId));
        assertEq(collection.mintCount(), 1);
        assertEq(collection.lastMinter(), address(fpss));
        assertEq(collection.lastTokenId(), TOKEN_ID);
        assertEq(collection.lastQuantity(), 1);
        assertEq(collection.lastRewardRecipient(), REFERRAL);
        assertEq(collection.lastMintTo(), artist);
        assertEq(address(collection).balance, GOAL); // full pool became payment
        assertEq(address(pool).balance, 0);
    }

    function test_execute_underGoalReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);

        vm.expectRevert(KismetGiftPool.PoolNotFull.selector);
        pool.execute(poolId);
    }

    function test_execute_twiceReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);
        pool.execute(poolId);

        vm.expectRevert(KismetGiftPool.PoolAlreadyExecuted.selector);
        pool.execute(poolId);
    }

    function test_execute_unknownPoolReverts() public {
        vm.expectRevert(KismetGiftPool.NoSuchPool.selector);
        pool.execute(42);
    }

    function test_execute_failSafeWhenSaleRepriced() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);

        // Artist edits the sale price after the pool froze its goal: the
        // strict value check on the mint path now rejects the frozen amount.
        collection.setExpectedValue(GOAL + 0.01 ether);

        vm.expectRevert(Mock1155.WrongValueSent.selector);
        pool.execute(poolId);

        // Fail-safe: nothing consumed, executed still false, withdrawal live.
        assertFalse(_executed(poolId));
        uint256 before = patronA.balance;
        vm.prank(patronA);
        pool.withdraw(poolId);
        assertEq(patronA.balance - before, GOAL);
    }

    // ----------------------------------------------------- fillAndExecute

    function test_fillAndExecute_paysRemainderAndMints() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);

        uint256 remainder = GOAL - 0.01 ether;
        vm.prank(artist);
        pool.fillAndExecute{value: remainder}(poolId);

        assertTrue(_executed(poolId));
        assertEq(collection.mintCount(), 1);
        assertEq(collection.lastMintTo(), artist);
        assertEq(pool.contributions(poolId, artist), remainder);
        assertEq(address(pool).balance, 0);
    }

    function test_fillAndExecute_wrongRemainderReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);

        vm.prank(artist);
        vm.expectRevert(KismetGiftPool.NotExactRemainder.selector);
        pool.fillAndExecute{value: GOAL}(poolId); // stale remainder — too much
    }

    function test_fillAndExecute_staleAfterConcurrentContribution() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);
        uint256 staleRemainder = GOAL - 0.01 ether;

        // A patron lands between the artist reading the remainder and closing.
        vm.prank(patronB);
        pool.contribute{value: 0.005 ether}(poolId);

        vm.prank(artist);
        vm.expectRevert(KismetGiftPool.NotExactRemainder.selector);
        pool.fillAndExecute{value: staleRemainder}(poolId);
    }

    function test_fillAndExecute_zeroValueOnFullPoolIsExecute() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL}(poolId);

        vm.prank(artist);
        pool.fillAndExecute{value: 0}(poolId);
        assertTrue(_executed(poolId));
        assertEq(collection.mintCount(), 1);
    }

    function test_fillAndExecute_zeroValueUnderGoalReverts() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(poolId);

        vm.prank(artist);
        vm.expectRevert(KismetGiftPool.PoolNotFull.selector);
        pool.fillAndExecute{value: 0}(poolId);
    }

    function test_fillAndExecute_wholeGoalOnEmptyPool() public {
        // Degenerate but legal: the artist funds the entire mint solo.
        uint256 poolId = _createPool();
        vm.prank(artist);
        pool.fillAndExecute{value: GOAL}(poolId);
        assertTrue(_executed(poolId));
        assertEq(collection.lastMintTo(), artist);
    }

    // --------------------------------------------------------- reentrancy

    function test_reentrancy_withdrawDuringWithdraw() public {
        uint256 poolId = _createPool();
        ReentrantPatron attacker = new ReentrantPatron(pool);
        vm.deal(address(attacker), 1 ether);
        attacker.contribute{value: 0.01 ether}(poolId);

        attacker.arm(poolId, pool.withdraw.selector);
        uint256 before = address(attacker).balance;
        attacker.withdraw(poolId);

        assertEq(attacker.reentryAttempts(), 1);
        assertFalse(attacker.innerCallSucceeded()); // guard rejected re-entry
        assertEq(address(attacker).balance - before, 0.01 ether); // paid ONCE
        assertEq(pool.contributions(poolId, address(attacker)), 0);
        assertEq(_raised(poolId), 0);
        assertEq(address(pool).balance, 0);
    }

    function test_reentrancy_contributeDuringRefund() public {
        uint256 poolId = _createPool();
        vm.prank(patronA);
        pool.contribute{value: GOAL - 0.001 ether}(poolId);

        ReentrantPatron attacker = new ReentrantPatron(pool);
        vm.deal(address(attacker), 1 ether);
        attacker.arm(poolId, pool.contribute.selector);
        // Overshoot → refund → attacker's receive() tries to re-enter
        // contribute during the send. Guard rejects it.
        attacker.contribute{value: 0.5 ether}(poolId);

        assertEq(attacker.reentryAttempts(), 1);
        assertFalse(attacker.innerCallSucceeded());
        assertEq(_raised(poolId), GOAL);
        assertEq(address(pool).balance, GOAL);
    }

    // --------------------------------------------------------- invariants

    function test_strayEthRefused() public {
        vm.prank(patronA);
        (bool ok,) = address(pool).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(address(pool).balance, 0);
    }

    function test_balanceEqualsActiveRaised_acrossPools() public {
        uint256 a = _createPool();
        vm.prank(artist);
        uint256 b = pool.create(TOKEN_ID, patronB);

        vm.prank(patronA);
        pool.contribute{value: 0.01 ether}(a);
        vm.prank(patronB);
        pool.contribute{value: 0.02 ether}(b);
        vm.prank(patronA);
        pool.contribute{value: GOAL - 0.01 ether}(a);

        assertEq(address(pool).balance, GOAL + 0.02 ether);

        pool.execute(a); // pool a's goal leaves as the mint payment
        assertEq(address(pool).balance, 0.02 ether);

        vm.prank(patronB);
        pool.withdraw(b);
        assertEq(address(pool).balance, 0);
    }

    function test_fuzz_contributeWithdrawConserves(uint96 amount) public {
        amount = uint96(bound(amount, pool.MIN_CONTRIBUTION(), 5 ether));
        uint256 poolId = _createPool();

        uint256 before = patronA.balance;
        vm.prank(patronA);
        pool.contribute{value: amount}(poolId);
        vm.prank(patronA);
        pool.withdraw(poolId);

        // Round-trips exactly: clamp + refund + withdraw never leak a wei.
        assertEq(patronA.balance, before);
        assertEq(address(pool).balance, 0);
        assertEq(_raised(poolId), 0);
    }
}
