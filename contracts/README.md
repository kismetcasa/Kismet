# KismetGiftPool

On-chain "gift group" escrow for Patron-collection artworks: an artist (or any
creator) opens a pool naming a recipient, patrons add ETH, and the moment the
pool holds exactly the mint's cost anyone can execute it — the edition is
minted **straight to the recipient** through Zora's fixed-price sale strategy,
emitting the same primary-mint `TransferSingle(0x0 → recipient)` genesis event
an ordinary collect does, so the platform's Pass provenance gate credits it
with no special handling.

## Design

- **One collection, fixed at deploy.** The 1155 the pool mints from is an
  immutable constructor argument — every Patron drop is a tokenId under a
  single collection address, so one deployment covers all current and future
  drops. This is the safety keystone: `execute()` sends the pooled ETH into
  `collection.mint`, so a *caller-supplied* collection would let a pool be
  pointed at an attacker contract that keeps the money. Fixing the address
  means patron funds can only ever flow into the real, vetted Zora mint that
  pays the artist. A second, genuinely separate collection would get its own
  pool deployment.
- **No deadlines, no owner, no admin, no custody beyond the pool.** A
  contribution is withdrawable by its sender at any time until the instant of
  execution — self-service exit *is* the refund mechanism. If a fund stalls,
  every patron simply takes their money back. There are no privileged roles:
  nothing and no one can move pooled ETH except the contributor (withdraw) or
  a completed mint (execute).
- **Goal read from chain, then frozen.** `create()` reads the live
  fixed-price sale (`sale()` on the strategy) plus the collection's
  `mintFee()`; nobody supplies a number. A later price edit can only make
  `execute()` revert (the strategy's strict value check), never mis-spend —
  and withdrawals stay live, so the failure mode is fail-safe by structure.
- **Overshoot impossible.** Contributions are clamped to the remaining need
  and any excess refunds in the same transaction, so the pool can only ever
  hold exactly its goal.
- **Artist can close at any time** with `fillAndExecute()`: pay the exact
  remainder and mint in one transaction (exactness makes a concurrent
  contribution revert the close cleanly instead of overpaying).
- Dust floor `MIN_CONTRIBUTION = 0.0001 ether` (waived for the exact final
  fill), per-pool ceiling `MAX_GOAL = 5 ether`, custom reentrancy guard,
  stray ETH refused so `balance == Σ active raised` stays checkable.

## Build & test

Requires [Foundry](https://book.getfoundry.sh/getting-started/installation)
and forge-std (gitignored):

```sh
forge install foundry-rs/forge-std@v1.16.2
forge build
forge test
```

`foundry.toml` pins `solc 0.8.30`. 39 tests cover goal derivation, the
immutable-collection lock (including an attacker registering a sale for their
own contract on the shared FPSS — unreachable), the sale-ended guard, the
contribute clamp/refund/dust rules, withdraw-anytime semantics, execution,
exact-remainder close, the at-goal withdraw/execute race, the repriced-sale
fail-safe, reentrancy on both send paths, refund/withdraw to ETH-rejecting
wallets, the balance invariant across pools, and a fuzzed
contribute→withdraw conservation round-trip.

## Safety model

The audited property is that **no patron can unintentionally lose money.**
Every failure mode is fail-safe by structure:

- Funds can only leave the contract two ways — a contributor's own
  `withdraw` (their exact contribution, any time before execution), or a
  completed `execute` (the pooled ETH becomes the mint payment for a real
  Zora mint that pays the artist). There is no third path and no privileged
  role.
- The collection is immutable, so pooled ETH can never be routed into an
  arbitrary/attacker contract.
- The goal is frozen at create; any later sale reprice, fee change, sell-out,
  or sale-end makes `execute` revert (Zora's strict value check) while
  withdrawals stay live — a pool that can't complete is always fully
  refundable.
- A recipient that can't receive the 1155, or an ETH-rejecting contributor
  wallet, only makes its own call revert; nothing is stranded.
- Forced ETH (selfdestruct) can over-fund the contract balance but is never
  attributed to a pool and never affects a withdrawal (paid from the
  contribution mapping, not the balance).

## Deployment (Base)

Constructor arguments — all three canonical in the app repo:

| arg | value |
| --- | --- |
| `fixedPriceStrategy_` | `ZORA_FIXED_PRICE_STRATEGY` (`lib/zoraMint.ts`) — `0x2994762aA0E4C750c51f333C10d81961faEBE785` |
| `mintReferral_` | `KISMET_REFERRAL` (`lib/zoraMint.ts`) — `0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75` |
| `collection_` | `PATRON_COLLECTION_ADDRESS` (`lib/patronCollection.ts`) — `0x80ce7bd430f34792490a22ee0fd479e7333715c9` |

The contract is unowned and immutable once deployed: no upgrade path, no
pause, no privileged roles.
