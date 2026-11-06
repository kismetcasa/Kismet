# Arkiv feedback

What got in our way building claim drops on `@arkiv-network/sdk` 1.0.1
against Rabdi, most important first. Each item: what we expected, what
happened, how to reproduce, and what would fix it.

## 1. Smart-wallet users can't write to Arkiv at all

- **Expected:** our users — mostly Base Accounts inside the Base App and
  Farcaster — could own and manage their entities directly.
- **What happened:** a Base Account is an ERC-4337 smart contract deployed on
  Base. It doesn't exist on Rabdi, and its wallet won't sign a Rabdi
  transaction, so it can never send `createEntity`, `changeOwnership` or
  `deleteEntity` itself.
- **Reproduce:** connect a Coinbase / Base Account wallet and call
  `walletClient.createEntity(...)` on Rabdi.
- **What we built instead:** users sign EIP-712 intents on Base (verified with
  ERC-1271); a Kismet server wallet writes every entity and hands it to the
  user. It works, but the user's "ownership" is one they can't exercise from
  that wallet.
- **Ask:** a relayed write authorized by an off-chain signature from the
  owner, verified on-chain — EIP-712 for EOAs, plus ERC-1271/6492 checked
  against a configured chain (e.g. Base) for smart wallets. Even
  owner-authorized `changeOwnership` / `deleteEntity` alone would cover most
  needs.

## 2. No way to create an entity *for* someone else

- **Expected:** `createEntity(schema, values, { owner })`.
- **What happened:** the creator is always the owner. To create-and-hand-off
  atomically we predict the key (`predictEntityKeys`, from the writer's entity
  nonce) and put a `changeOwnership` for that key in the same `executeBatch`.
  A prediction is only valid if nothing else creates as the writer before the
  transaction lands, so **every write must go through one serialized queue**
  ([`lib/arkiv/client.ts`](../lib/arkiv/client.ts)). We can't run two app
  instances with the same writer key.
- **Reproduce:** from two processes with the same key, run
  `predictEntityKeys({ owner, count: 1 })` then `executeBatch({ creates,
  ownershipChanges })` at the same time. One batch reverts.
- **Ask:** an `owner` field on create. `$creator` already keeps the
  attestation; this would remove the prediction dance and the
  single-writer bottleneck.

## 3. No conditional writes, so caps and uniqueness live in Redis

- **Expected:** a way to say "create this claim only if this wallet has none
  for this drop" or "only if fewer than N exist".
- **What happened:** there is no compare-and-set, unique index or guarded
  create. Two claims for the last slot would both land. The claim cap and
  one-claim-per-wallet are decided by a Redis Lua script
  ([`lib/dropsStore.ts`](../lib/dropsStore.ts)) and Arkiv only records the
  outcome.
- **Ask:** a uniqueness constraint over indexed attributes (here,
  `(drop, collector)`), or a create guarded by a count query.

## 4. `str` holds 128 bytes

- **Expected:** a title attribute could hold a title.
- **What happened:** `MAX_STRING_BYTES = 128`. A 40-emoji title (160 bytes)
  fails, so we validate UTF-8 byte length as well as characters
  ([`lib/drops.ts`](../lib/drops.ts)). Descriptions and signatures had to be
  `bytes`, which can't be filtered or searched.
- **Ask:** a larger text type (even if unindexed), and say the 128-byte limit
  prominently in the schema docs, next to `str()`.

## 5. A feed of N drops costs N + 1 queries

- **Expected:** one query for "open drops with their claim counts".
- **What happened:** we run one `select` for the drops plus one `count()` per
  drop for "37 / 100 claimed". The README mentions `select(...).withCount()`,
  but that counts the page's own matches, not related entities.
- **Ask:** a grouped count (count of `kismet.claim.v1` grouped by `drop` for a
  set of keys), or a batch of counts in one RPC call.

## 6. `$expiresAt` is a block number

- **Expected:** to show users "this record expires on 13 Nov".
- **What happened:** `$expiresAt` is a block height, and block time is only
  nominal (2 s). We show a date computed from our own `closesAt`
  attribute instead. `getBlockTiming()` exists, but converting is on every
  app.
- **Ask:** an approximate wall-clock expiry next to the block height in query
  results.

## 7. Testnet only, after a testnet sunset

- **Expected:** to ship this to our users after the event.
- **What happened:** the SDK ships only the `rabdi` testnet chain, and the
  previous testnet (Braga) was shut down with an export deadline. We can't
  promise collectors anything permanent on Rabdi, so **the design keeps only
  short-lived state on Arkiv** (an open drop plus 7 days); what they keep —
  the NFT — is on Base. A reset would lose pending claims, never art.
- **Ask:** a mainnet date and a written migration guarantee for testnet
  entities, so apps can plan for longer-lived data.

## What went well

- The npm package ships the SDK's TypeScript source and a long README. Our
  sandbox couldn't reach docs.arkiv.network, and we built entirely from the
  README and the source in `node_modules`.
- Typed schemas caught real mistakes at compile time: filtering on a
  non-indexed column, comparing a `u64` with a number.
- `executeBatch` applying creates before ownership changes made the atomic
  create-and-hand-off possible at all.
- `createdBy()` made anti-spoofing a one-liner.

## Live-run notes

TODO(team): after running `npm run drops:smoke` and the demo against Rabdi,
add anything that broke: RPC errors, rate limits, explorer link formats.
We could not reach Rabdi from our build sandbox, so the code has been
typechecked and exercised offline but not yet against the live chain.
