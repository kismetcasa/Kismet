# KismetGiftPool

On-chain "gift group" escrow for Patron-collection artworks: an artist (or any
creator) opens a pool naming a recipient, patrons add ETH, and the moment the
pool holds exactly the mint's cost anyone can execute it — the edition is
minted **straight to the recipient** through Zora's fixed-price sale strategy,
emitting the same primary-mint `TransferSingle(0x0 → recipient)` genesis event
an ordinary collect does, so the platform's Pass provenance gate credits it
with no special handling.

## Design

- **No deadlines, no admin, no custody beyond the pool.** A contribution is
  withdrawable by its sender at any time until the instant of execution —
  self-service exit *is* the refund mechanism. If a fund stalls, every patron
  simply takes their money back.
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

`foundry.toml` pins `solc 0.8.30`. 36 tests cover goal derivation, the
contribute clamp/refund/dust rules, withdraw-anytime semantics, execution,
exact-remainder close, the at-goal withdraw/execute race, the repriced-sale
fail-safe, reentrancy on both send paths, refund/withdraw to ETH-rejecting
wallets, the balance invariant across pools, and a fuzzed
contribute→withdraw conservation round-trip.

## Deployment (Base)

Constructor arguments, both canonical in `lib/zoraMint.ts`:

| arg | value |
| --- | --- |
| `fixedPriceStrategy_` | `ZORA_FIXED_PRICE_STRATEGY` — `0x2994762aA0E4C750c51f333C10d81961faEBE785` |
| `mintReferral_` | `KISMET_REFERRAL` — `0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75` |

The contract is unowned and immutable once deployed: no upgrade path, no
pause, no privileged roles.
