// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  KismetGiftPool
/// @notice Community-funded gifts of Zora 1155 primary mints ("gift groups").
///         An artist (or anyone) opens a pool naming a recipient; patrons add
///         ETH; the moment the pool holds exactly the mint's cost, anyone can
///         execute it and the edition is minted STRAIGHT to the recipient —
///         the same primary-mint genesis event an ordinary collect emits, so
///         the platform's provenance gate credits it with no special handling.
///
///         DESIGN: no deadlines, no admin, no custody beyond the pool itself.
///         A contribution is withdrawable by its sender AT ANY TIME until the
///         instant of execution — self-service exit IS the refund mechanism,
///         so there is no expiry machinery and no stranded-funds state:
///         * pool fills → executed → funds became the mint payment;
///         * pool stalls → every patron withdraws whenever they choose;
///         * the underlying sale ends, sells out, or its price is edited →
///           execute() reverts forever (the strategy's own strict checks) and
///           withdrawals remain live — fail-safe by structure.
///         The at-goal ordering race (a withdrawal and an execution both in
///         flight) is benign: sequencer order decides, and both outcomes are
///         coherent — withdraw-first drops the pool below goal (execute
///         reverts, pool continues); execute-first consumes the pool
///         (withdraw reverts, gift minted).
///
///         The goal is READ FROM CHAIN at creation (fixed-price sale +
///         collection mint fee) and frozen: nobody supplies a number, and a
///         later price edit can only make execution revert, never mis-spend.
///         Contributions are clamped to the remaining need, so overshoot is
///         impossible and the final contributor pays the exact remainder —
///         which is also how the artist "closes at any time": fillAndExecute
///         tops up whatever is missing and mints in one transaction.
contract KismetGiftPool {
    // ---------------------------------------------------------------- types

    struct Pool {
        address collection;
        uint256 tokenId;
        address recipient;
        uint256 goal; // pricePerToken + mintFee, frozen at create
        uint256 raised;
        bool executed;
    }

    // ------------------------------------------------------------- storage

    /// @notice Zora FixedPriceSaleStrategy this deployment reads sales from
    ///         and passes as the minter on execute. Immutable: one pool
    ///         contract serves one strategy, matching the platform's single
    ///         configured FPSS.
    address public immutable fixedPriceStrategy;

    /// @notice Zora mint-referral recipient for executed gifts (the
    ///         platform's referral address, as on every platform mint).
    address public immutable mintReferral;

    uint256 public nextPoolId;
    mapping(uint256 => Pool) public pools;
    mapping(uint256 => mapping(address => uint256)) public contributions;

    // ------------------------------------------------------------ constants

    /// @notice Dust floor. Applies to each contribution EXCEPT one that
    ///         exactly fills the pool — the clamp can shrink the final
    ///         contribution below any floor, and refusing it would strand
    ///         the pool one sliver short forever.
    uint256 public constant MIN_CONTRIBUTION = 0.0001 ether;

    /// @notice Per-pool ceiling. Bounds the blast radius of any defect to a
    ///         known figure; far above any pass price.
    uint256 public constant MAX_GOAL = 5 ether;

    // -------------------------------------------------------------- events

    event PoolCreated(
        uint256 indexed poolId,
        address indexed collection,
        uint256 indexed tokenId,
        address recipient,
        address creator,
        uint256 goal
    );
    event Contributed(uint256 indexed poolId, address indexed patron, uint256 amount, uint256 raised);
    event Withdrawn(uint256 indexed poolId, address indexed patron, uint256 amount, uint256 raised);
    event Executed(uint256 indexed poolId, address indexed executor);

    // -------------------------------------------------------------- errors

    error NoSuchPool();
    error PoolAlreadyExecuted();
    error PoolNotFull();
    error NothingToWithdraw();
    error BelowMinimum();
    error PoolFull();
    error ZeroRecipient();
    error SaleNotConfigured();
    error GoalTooLarge();
    error RefundFailed();
    error WithdrawFailed();
    error NotExactRemainder();
    error Reentrancy();
    error NoStrayEth();

    // -------------------------------------------------- reentrancy guard

    uint256 private _lock = 1;

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    // ---------------------------------------------------------------- init

    constructor(address fixedPriceStrategy_, address mintReferral_) {
        fixedPriceStrategy = fixedPriceStrategy_;
        mintReferral = mintReferral_;
    }

    /// @dev Stray ETH is refused: every wei in this contract must belong to a
    ///      pool, so the invariant `balance == Σ active raised` stays checkable.
    receive() external payable {
        revert NoStrayEth();
    }

    // -------------------------------------------------------------- create

    /// @notice Open a gift group for `recipient` on an artwork with a live
    ///         ETH fixed-price sale. The goal is read from chain and frozen —
    ///         no caller-supplied amounts. Anyone may create; the recipient
    ///         creating their own pool ("help me get my pass") is the
    ///         expected primary use.
    function create(address collection, uint256 tokenId, address recipient)
        external
        returns (uint256 poolId)
    {
        if (recipient == address(0)) revert ZeroRecipient();

        IFixedPriceSaleStrategy.SalesConfig memory saleConfig =
            IFixedPriceSaleStrategy(fixedPriceStrategy).sale(collection, tokenId);
        // saleEnd == 0 is Zora's "no sale row" shape (matches the platform's
        // own resolveOnchainSale semantics).
        if (saleConfig.saleEnd == 0) revert SaleNotConfigured();

        uint256 goal = uint256(saleConfig.pricePerToken) + IZora1155(collection).mintFee();
        if (goal == 0 || goal > MAX_GOAL) revert GoalTooLarge();

        poolId = nextPoolId++;
        pools[poolId] = Pool({
            collection: collection,
            tokenId: tokenId,
            recipient: recipient,
            goal: goal,
            raised: 0,
            executed: false
        });
        emit PoolCreated(poolId, collection, tokenId, recipient, msg.sender, goal);
    }

    // ---------------------------------------------------------- contribute

    /// @notice Add ETH to a pool. Clamped to the remaining need — any excess
    ///         is returned in the same transaction, so overshoot is
    ///         impossible and the final patron pays the exact remainder.
    function contribute(uint256 poolId) external payable nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.recipient == address(0)) revert NoSuchPool();
        if (pool.executed) revert PoolAlreadyExecuted();

        uint256 room = pool.goal - pool.raised;
        if (room == 0) revert PoolFull();
        uint256 take = msg.value > room ? room : msg.value;
        // Dust floor, waived only for the exact fill (see MIN_CONTRIBUTION).
        if (take < MIN_CONTRIBUTION && take != room) revert BelowMinimum();

        pool.raised += take;
        contributions[poolId][msg.sender] += take;
        emit Contributed(poolId, msg.sender, take, pool.raised);

        uint256 excess = msg.value - take;
        if (excess > 0) {
            (bool ok,) = msg.sender.call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ------------------------------------------------------------ withdraw

    /// @notice Take your whole contribution back — any time before execution.
    ///         This is the refund mechanism: there are no deadlines and no
    ///         expiry claims, only funds that remain yours until the gift is
    ///         actually bought.
    function withdraw(uint256 poolId) external nonReentrant {
        Pool storage pool = pools[poolId];
        if (pool.recipient == address(0)) revert NoSuchPool();
        if (pool.executed) revert PoolAlreadyExecuted();

        uint256 amount = contributions[poolId][msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        contributions[poolId][msg.sender] = 0;
        pool.raised -= amount;
        emit Withdrawn(poolId, msg.sender, amount, pool.raised);

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    // ------------------------------------------------------------- execute

    /// @notice Mint the gift. Callable by ANYONE once the pool holds exactly
    ///         its goal — the recipient is the natural caller (it is their
    ///         gift), the platform a backstop. Effects-first: the pool is
    ///         marked executed before the external mint, and the strategy's
    ///         own strict value check is the final arbiter — if the sale
    ///         ended, sold out, or was re-priced since creation, this reverts
    ///         in full and every contribution remains withdrawable.
    function execute(uint256 poolId) external nonReentrant {
        _execute(poolId);
    }

    /// @notice The artist's "close it now": pay the exact remainder and mint,
    ///         one transaction. msg.value must equal `goal - raised` — the
    ///         panel computes it, and exactness means a concurrent
    ///         contribution makes this revert cleanly rather than overpay.
    ///         With msg.value 0 on a full pool it is exactly execute().
    function fillAndExecute(uint256 poolId) external payable nonReentrant {
        if (msg.value > 0) {
            Pool storage pool = pools[poolId];
            if (pool.recipient == address(0)) revert NoSuchPool();
            if (pool.executed) revert PoolAlreadyExecuted();
            if (msg.value != pool.goal - pool.raised) revert NotExactRemainder();
            pool.raised += msg.value;
            contributions[poolId][msg.sender] += msg.value;
            emit Contributed(poolId, msg.sender, msg.value, pool.raised);
        }
        _execute(poolId);
    }

    function _execute(uint256 poolId) internal {
        Pool storage pool = pools[poolId];
        if (pool.recipient == address(0)) revert NoSuchPool();
        if (pool.executed) revert PoolAlreadyExecuted();
        if (pool.raised != pool.goal) revert PoolNotFull();

        pool.executed = true;

        address[] memory rewards = new address[](1);
        rewards[0] = mintReferral;
        IZora1155(pool.collection).mint{value: pool.goal}(
            fixedPriceStrategy,
            pool.tokenId,
            1,
            rewards,
            abi.encode(pool.recipient, "")
        );
        emit Executed(poolId, msg.sender);
    }
}

// ------------------------------------------------------------- interfaces

interface IZora1155 {
    function mint(
        address minter,
        uint256 tokenId,
        uint256 quantity,
        address[] calldata rewardsRecipients,
        bytes calldata minterArguments
    ) external payable;

    function mintFee() external view returns (uint256);
}

interface IFixedPriceSaleStrategy {
    struct SalesConfig {
        uint64 saleStart;
        uint64 saleEnd;
        uint64 maxTokensPerAddress;
        uint96 pricePerToken;
        address fundsRecipient;
    }

    function sale(address tokenContract, uint256 tokenId)
        external
        view
        returns (SalesConfig memory);
}
