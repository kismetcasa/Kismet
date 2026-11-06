# Arkiv feedback

What got in our way building claim drops on `@arkiv-network/sdk` 1.0.1 (the
latest on npm) against Rabdi, most important first. Each item says what we
expected, what happened, how to reproduce it, and what would fix it. Every
item was checked against docs.arkiv.network on 2026-11-06, so none of them is
something the docs already cover.

## 1. Smart-wallet users can't write to Arkiv

- **Expected:** our users, mostly Base Accounts inside the Base App and
  Farcaster, could own and manage their entities directly.
- **What happened:** the React guide's path is an injected wallet that adds
  and switches to Rabdi (`addChain`, then sign each write on Rabdi). A Base
  Account is an ERC-4337 smart contract deployed on Base. It doesn't exist on
  Rabdi, so it can never send `createEntity`, `changeOwnership` or
  `deleteEntity` itself, and the docs don't mention smart-contract wallets.
- **Reproduce:** connect a Coinbase / Base Account wallet in the
  [React guide](https://docs.arkiv.network/guides/react/)'s setup and try a
  write on Rabdi.
- **What we built instead:** users sign EIP-712 intents on Base (verified
  with ERC-1271). A Kismet server wallet writes every entity and hands it to
  the user. It works, but the user owns an entity they can't act on from
  that wallet.
- **Ask:** a relayed write authorized by an off-chain signature from the
  owner and verified on-chain: EIP-712 for EOAs, ERC-1271/6492 checked against
  a configured chain such as Base for smart wallets. Even owner-authorized
  `changeOwnership` / `deleteEntity` alone would cover most needs.

## 2. No way to create an entity *for* someone else

- **Expected:** `createEntity(schema, values, { owner })`.
- **What happened:** "The account that creates an entity owns it." To create
  and hand off atomically we predict the key with `predictEntityKeys` and put
  a `changeOwnership` for that key in the same `executeBatch`. But "a
  prediction holds only while nothing else from the same account lands
  first", so **every write must go through one serialized queue**
  ([`lib/arkiv/client.ts`](../lib/arkiv/client.ts)), and two app instances
  can't share a writer key.
- **Reproduce:** `eth_call` an `execute` batch that creates an entity
  without the predicted salt and transfers the predicted key. It reverts with
  `EntityNotFound(bytes32)` (we ran this on Rabdi). That's safe, but it is
  exactly what a concurrent writer causes.
- **Ask:** an `owner` field on create. `$creator` already keeps the
  attestation; this would remove both the prediction step and the
  single-writer bottleneck.

## 3. No conditional writes, so caps and uniqueness live in Redis

- **Expected:** a way to say "create this claim only if this wallet has none
  for this drop", or "only if fewer than N exist".
- **What happened:** there is no compare-and-set, unique index or guarded
  create. Two claims for the last slot would both land. The claim cap and
  one-claim-per-wallet are decided by a Redis Lua script
  ([`lib/dropsStore.ts`](../lib/dropsStore.ts)); Arkiv only records the
  outcome.
- **Ask:** a uniqueness constraint over indexed attributes (here,
  `(drop, collector)`), or a create guarded by a count.

## 4. `llms.txt` advertises pagination APIs that don't exist

- **Expected:** what [llms.txt](https://docs.arkiv.network/llms.txt) lists
  for "Paginate results": "`limit` (max 100), `fetch`, `next`, `for await`,
  `cursor`, `atBlock`".
- **What happened:** the
  [paginate page](https://docs.arkiv.network/querying/paginate/) has none of
  `next`, `for await`, `cursor` or `atBlock`. Neither does the SDK: 1.0.1's
  `QueryResult` says "A page is one request: to read further, run the query
  again with an `offset()`". An AI coding tool that reads `llms.txt` as its
  map of the API writes calls that don't exist.
- **Reproduce:** compare line 27 of `llms.txt` with the paginate page, or
  `grep -rn cursor node_modules/@arkiv-network/sdk/src/query`.
- **Ask:** align `llms.txt` with the SDK, or ship the cursor API it
  describes. A built-in "read every match" helper would also have saved us
  the keyset loop in item 6.

## 5. A feed of N drops costs N + 1 queries

- **Expected:** one query for "open drops with their claim counts".
- **What happened:** we run one `select` for the drops plus one `count()`
  per drop for "37 / 100 claimed". `withCount` counts a page's own matches,
  not related entities, and the `count` projection of `arkiv_query` is one
  total per query ([read methods](https://docs.arkiv.network/json-rpc/querying-data/)).
  Each call spends the access key's monthly quota, so we had to cache the
  feed server-side.
- **Ask:** a grouped count (count of `kismet.claim.v1` grouped by `drop` for
  a set of keys), or several counts in one call.

## 6. `str` holds 128 bytes, and there's no bigger text type

- **Expected:** somewhere to put a free-text description that a query can
  still match.
- **What happened:** the limit is clearly documented ("the 128-byte limit
  counts bytes, not characters"), but a description longer than 128 bytes can
  only go in `bytes`, which "can't be indexed, so it can't be filtered on".
  Titles need a UTF-8 byte check as well as a character check
  ([`lib/drops.ts`](../lib/drops.ts)).
- **Ask:** a larger text type, even unindexed but `startsWith`-able, or
  documented guidance on storing searchable text.

## 7. Testnet only, after a testnet sunset

- **Expected:** to ship this to our users after the event.
- **What happened:** the SDK ships only the `rabdi` testnet chain, and the
  previous testnet (Braga) was shut down with an export deadline. We can't
  promise collectors anything permanent on Rabdi, so **the design keeps only
  short-lived state on Arkiv** (an open drop, plus 7 days to settle). What
  collectors keep, the NFT, is on Base. A reset would lose pending claims,
  never art.
- **Ask:** a mainnet date, and a written migration guarantee for testnet
  entities, so apps can plan for longer-lived data.

## What went well

- `llms.txt` and the `.md` version of every page made it fast to check our
  code against the docs line by line.
- The [write-transaction spec](https://docs.arkiv.network/json-rpc/mutating-entities/)
  names every revert error. We simulated our batch with `eth_call` and
  decoded `EntityNotFound` and `TransferToSelf` from the selectors, which
  proved the design without spending tGLM.
- Typed schemas caught real mistakes at compile time: filtering on a
  non-indexed column, a `u64` written as a plain number, and a query helper
  that would have bypassed the schema check.
- `executeBatch` applying creates before ownership changes, atomically, made
  the create-and-hand-off possible at all.
- `createdBy()` made anti-spoofing a one-liner, and the docs say plainly why
  it's needed.

## Live-run notes

Validated so far (2026-11-06): every read query against Rabdi, the write
batch by `eth_call` simulation, and gas for 1 and 16 claims. TODO(team): after
`npm run drops:smoke` with a funded writer and the demo, add anything that
broke (RPC errors, rate limits, quota).
