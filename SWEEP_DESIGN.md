# Sweep — "one of everything" across the catalog — Feasibility & Design Options

_Research for the proposed **sweep** button: one wallet action that collects one
edition each of the cheapest 10–20 **paid** mints currently live on Kismet, across
every artist and collection, so a collector gets broad exposure in a single
transaction. Free mints are excluded by request. This document establishes what
is feasible on the current stack, enumerates every viable way to build it, prices
each, and recommends a phased path. Nothing here is implemented; it is the
decision record for choosing the implementation._

> **Decision (2026-09-26) — ETH-only.** The sweep will cover **ETH-priced
> (FixedPriceSaleStrategy) mints on Base only**. USDC and mixed baskets (§3,
> §4.3 E2/E3, §5 Phases 2–3) are out of scope. The implementation design for
> the chosen variant is in **`SWEEP_IMPLEMENTATION.md`**; this document stays
> as the record of the option space and why the ETH-only path was the safe one.

> **How to read this.** §0 is the verdict. §1 pins down what the words in the
> request mean on-chain. §2 is what already exists (the sweep is mostly a
> recombination of shipped pieces) and where the real bottlenecks are. §3–4 are
> the option space for the three layers a sweep needs — **discovery**, **ranking**,
> **execution** — with the safety layer that sits between preview and signature.
> §5 is the recommended architecture, §6 the cost model, §7 risks, §8 the
> implementation delta, §9 the product decisions only the team can make, and
> §10 the validation record (what was verified against source, what was not).
> Evidence is cited by **file + function/constant name** rather than line number;
> this repository's own comments note that line anchors drift within weeks.

---

## 0. TL;DR

- **Feasible, and mostly already built.** A cross-collection sweep is the
  existing per-collection "collect all" (`hooks/useCollectAll.ts`) with a
  different candidate list. Multicall3's `aggregate3Value` takes an arbitrary
  `target` per sub-call, so an **ETH-only sweep across 20 collections is one
  transaction, one signature, on any wallet, with zero new contracts**. The
  agent API already builds cross-collection baskets today
  (`app/api/agent/prepare-collect-batch`, `lib/agent/collectBatch.ts`).
- **The "collect all" bottleneck is not the transaction; it is discovery.**
  Eligibility is resolved per collection with 2–4 RPC round trips each
  (`fetchEligibleTokens`; documented as F2 in `FEEDS_REVIEW.md`). A naive sweep
  would multiply that by every tracked collection on every click. The fix is a
  **materialized sweep index** (hourly cron + Redis, the same shape as the
  catalog census and the sale-end index) plus **one cross-collection multicall**
  at click time for freshness — the same "background pre-warming" remedy the
  feeds review already prescribes.
- **USDC is the only structural constraint.** The ERC20Minter pulls USDC from
  `msg.sender`, so USDC mints cannot ride Multicall3. They ride EIP-5792
  `wallet_sendCalls` exactly as they do in collect-all today: atomic on smart
  wallets (Coinbase Smart Wallet / Base Account, MetaMask post-Pectra),
  sequential prompts on legacy EOAs. A **single mixed ETH+USDC transaction on
  every wallet** requires a Kismet-owned router contract — a real step change
  (first Kismet contract, audit, ops) that the data does not yet justify.
- **Do not "fix" atomicity with Multicall3's `allowFailure`.** Verified against
  the Multicall3 source: a value-carrying sub-call that reverts under
  `allowFailure=true` leaves its ETH **stranded in Multicall3 forever** (no
  withdraw, no `receive`, and every later `aggregate3Value` must match
  `msg.value` exactly). Keep `allowFailure=false` and get partial-failure
  tolerance from **pre-flight simulation** instead (simulate with
  `allowFailure=true` via `eth_call`, drop the failing items, then sign the
  strict bundle).
- **Ranking needs a policy, not just a sort.** "Cheapest" must be defined as
  per-edition **outlay** (price + Zora's ~0.000111 ETH protocol fee for ETH
  mints; price alone for USDC), normalized to USD via the Chainlink feed the
  earnings view already uses (`lib/ethPrice.ts`). A pure cheapest-N sort is
  gameable (one artist mints twenty $0.10 pieces and owns every sweep) and
  works against the stated goal; a **per-artist cap** (default 1) and a
  **price floor** are recommended defaults, flagged as team decisions in §9.
- **Recommended path (§5):** Phase 1 ships an ETH-only (or USDC-only) sweep of
  the cheapest N ≤ 20 with a preview sheet, on the Multicall3 path; Phase 2
  enables mixed baskets through the EIP-5792 path that already exists; Phase 3
  (optional, data-driven) is the router contract. The `/api/sweep` endpoint
  should emit the same `AgentActionEnvelope` shape as `prepare-collect-batch`,
  so Base MCP agents get "sweep" for free.

---

## 1. The request, made precise

| Phrase in the request | On-chain / product meaning | Source of truth |
|---|---|---|
| "available piece" | A (collection, tokenId) whose sale is **live** (`saleStart ≤ now`, `saleEnd` unset/sentinel or `> now`), **not sold out** (`totalMinted < maxSupply` unless open edition), and where the buyer is **under the per-wallet cap** (`maxTokensPerAddress`) | `lib/saleConfig.ts` `fetchEligibleTokens`, `lib/zoraMint.ts` `isOpenEdition` |
| "minted on Kismet" | Strictly: a member of the created-mints registry (`kismetart:created-mints`, written by `lib/mint-proxy.ts` and the cover-mint path, plus off-platform admissions the timeline materializes after the 2026-08-01 epoch). Loosely: any moment in a **tracked collection** (`kismetart:collections`). The feeds use the first for the Mints scope and the second for everything else | `lib/kv.ts` `markCreatedMint` / `scanCreatedMints`, `lib/feedAdmission.ts` |
| "one of every" | Quantity 1 per token, and **skip tokens the buyer already holds** (`balanceOf(account, id) ≥ 1`) — the scout calls this `excludeOwnedAtOrAbove = 1n` | `fetchEligibleTokens(..., account, excludeOwnedAtOrAbove)` |
| "cheapest" | Per-edition **outlay**: ETH `pricePerToken + mintFee()`; USDC `pricePerToken`. Cross-currency comparison needs an ETH/USD rate | `buildEthMintCall` (`value = (mintFee + price) × qty`), `lib/ethPrice.ts` `getEthUsd` |
| "excluding free mints" | `pricePerToken == 0` on the active strategy. (A free ETH mint still costs the protocol fee, so "free" is a price property, not a cost property.) The free-mint index (`SALE_FREE_KEY`) already classifies this for browsed moments | `lib/inprocess.ts` `isZeroPrice`, `lib/saleEnds.ts` |
| "singular txn" | Literally one transaction hash. True for: Multicall3 (ETH-only, any wallet) and EIP-5792 **atomic** bundles (smart wallets). Not true for the EIP-5792 sequential fallback on legacy EOAs (N prompts, N hashes) | `hooks/useCollectAll.ts` dispatch branches |
| "10–20" | `MAX_COLLECT_ALL_BATCH = 20` is the existing cap, chosen for wallet-preview readability ("~5M gas for 20 × ~250k each on Base"), not for cost | `lib/zoraMint.ts` |
| Not an artwork | The Patron / Mint-Pass collection (`0x80ce…15c9`) is excluded from every artwork census and must be excluded here — passes carry validity semantics, and "collect a pass" is not what a sweep means | `lib/catalogCensus.ts` (patron exclusion), `lib/patronCollection.ts` |

Two consequences fall out of the definitions:

1. **"Available" is a function of `now`, of the buyer, and of supply.** The
   first two are cheap; supply (`getTokenInfo`) returns a `uri` string per row,
   which is why the feeds cap those reads (80 / 240 rows). A sweep index must
   chunk them.
2. **"Cheapest" is currency-dependent and fee-dependent.** A $0.50 USDC mint has
   no protocol fee; a 0.0001 ETH mint costs 0.000211 ETH all-in. Ranking on the
   bare price would systematically mis-rank sub-dollar ETH mints.

---

## 2. What already exists (and where the bottleneck really is)

### 2.1 Anatomy of the per-collection "collect all"

`hooks/useCollectAll.ts` (visible history from 2026-07; last hardened 2026-08-13) does, per click:

1. **Re-check eligibility** for the connected account with
   `fetchEligibleTokens(client, collection, ids, 'eth' | 'usdc', account)`:
   `getBlock` (chain time) + one multicall (`sale` + `getTokenInfo` per id) +
   one multicall (`balanceOf` per surviving id). Fail-closed on read errors so
   an RPC blip can't feed a reverting item into an atomic bundle.
2. **Cap** at `MAX_COLLECT_ALL_BATCH = 20`, ETH first.
3. **Build calls** with the treasury-critical builders `buildEthMintCall` /
   `buildUsdcMintCall` (Kismet's mint referral is hard-wired in both).
4. **Dispatch**:
   - pure-ETH and ≥ 2 mints → `Multicall3.aggregate3Value` via
     `writeContractAsync` — **one tx on any wallet**, per-call `value`
     partitioned so FPSS's strict `WrongValueSent` equality holds,
     `allowFailure=false`;
   - anything with USDC, or N = 1 → `wallet_sendCalls` (EIP-5792) with wagmi's
     `experimental_fallback`, plus a hand-rolled sequential fallback for wallets
     that reject the method with a non-standard error.
5. **Record** one `POST /api/collect` per token with the tx hash
   (`/api/collect` re-verifies the `TransferSingle` on-chain and is rate-limited
   at 60/min per IP — explicitly sized "to cover a full MAX_COLLECT_ALL_BATCH").

Nothing in steps 3–5 assumes a single collection: each segment already carries
its own `to`, and Multicall3 dispatches each sub-call to its own `target`. The
only per-collection reads are `readMintFeeWithBound` (one `mintFee()` per
collection) and step 1.

### 2.2 The cross-collection batch already exists for agents

`lib/agent/collectBatch.ts` `buildCollectBatchPlan` is a **pure, cross-collection**
basket builder (the verifier `scripts/verify-agent-collect-batch.ts` uses two
collections, `COL_A` and `COL_B`). It gets the one USDC subtlety right (a single
summed `approve` to the ERC20Minter, never per-item approves that would clobber
each other). `app/api/agent/prepare-collect-batch/route.ts` wraps it with
per-item on-chain resolution, `MAX_BATCH = 20`, and a `/api/collect` record hint
per item. Its own comment names the remaining inefficiency: *"Per-item reads;
fine for a ≤20 basket. A future optimization can group by collection into a
single multicall."*

### 2.3 The scout already does "one of each" with budgets

`lib/agent/scout/*` collects one edition of each new drop from watched artists
within a Spend Permission budget — it has the eligibility semantics
(`excludeOwnedAtOrAbove`), a fee-inclusive price cap (`maxItemPrice` compared
against `price + mintFee`), and a server-side execution path (CDP smart
account, atomic userOp, gas sponsored by a paymaster). Its discovery is
artist-scoped (`discoverCore`: timeline per watched artist → `/api/moments`
price batch), not catalog-wide.

### 2.4 The discovery infrastructure that already touches every moment

| Piece | What it knows | Cadence / cost |
|---|---|---|
| `lib/catalogCensus.ts` `rebuildCatalogCensus` | Walks **every tracked collection's full timeline** (200/page, ≤ 20 pages, concurrency 6), dedups, resolves creators (KV override + smart-wallet fold), applies the three hide sets, excludes the pass collection. Persists only counts | Hourly, from `app/api/cron/sync-stats` after `rebuildStats` |
| `lib/saleEnds.ts` `recordSaleEnds` | Write-through of every sale config `/api/moments` resolves: an **ending-soon zset** (`kismetart:sale-ends`, score = `saleEnd`) and a **free-mint zset** (`kismetart:sale-free`). 10k cap, per-pod seen-caches, throttled sweeps | On every uncached `/api/moments` batch, via `after()` |
| `lib/saleConfig.ts` `resolveOnchainSalesBatch` | Prices N `(collection, tokenId)` pairs **across collections in one Multicall3 `eth_call`** (both strategies per pair). This is the exact primitive a sweep needs, minus supply and balance | On demand (`/api/moments` Phase 2) |
| `lib/kv.ts` `scanCreatedMints` | Bounded SSCAN of the created-mints registry — a fan-out-free enumeration of everything minted through Kismet (used by the sitemap and search) | On demand, ~1 round trip per 1,000 members |
| `ANALYTICS.md` §7 snapshot (2026-07-16) | **42 artworks, 18 artists, 30 tracked collections**; 12 hidden. The tracked set is never pruned; `STACK_OVERVIEW.md` flags the feed merge as an OOM vector past ~250 collections | — |

### 2.5 Where the bottleneck actually is

The request says the bottleneck is "similar to our collections collect-all". Read
against the code, that bottleneck has four distinct parts, and a sweep inherits
all of them plus a fifth:

| # | Bottleneck | Where | Effect on a sweep |
|---|---|---|---|
| B1 | **Per-collection eligibility fan-out.** `loadCollectAllEligibility` (`app/api/collections/route.ts`) and `CollectionView` each call `fetchEligibleTokens` twice (ETH + USDC) → ≈ 4 RPC round trips per collection, uncached JSON-RPC (`FEEDS_REVIEW.md` F2) | Discovery | Multiplied by every tracked collection per click: 30 collections ≈ 120 RPC calls; 250 ≈ 1,000. Untenable on the hot path, and on the client it would burn the public `NEXT_PUBLIC_BASE_RPC_URL` key |
| B2 | **Batch cap = 20** for wallet-preview readability | Execution | The user's own scoping ("cheapest 10–20") already fits. Larger sweeps become rounds |
| B3 | **All-or-nothing atomicity.** One reverting sub-call (sold out / ended / cap hit between preview and mining) undoes the whole batch | Execution | Probability grows with N *and* with the number of independent sales. Twenty sales from twenty artists is the worst case for this |
| B4 | **USDC cannot ride Multicall3**; mixed baskets depend on the wallet's EIP-5792 support | Execution | Same as today; a sweep of the cheapest N will routinely mix currencies unless the policy pins one |
| B5 | **Catalog-wide candidate set does not exist anywhere yet.** No index knows "every live paid mint and its price"; the sale-end/free indexes only cover moments someone has browsed | Discovery | New: the sweep's defining data structure must be built |

B1 and B5 are solved by one artifact (a materialized index). B2 is a product
choice. B3 is mitigated by pre-flight simulation. B4 is the only one with a
hard wallet/contract dependency.

---

## 3. Feasibility verdicts

| Variant | Verdict | Why |
|---|---|---|
| **ETH-only sweep, cheapest N ≤ 20, one tx, any wallet** | ✅ Feasible now, no new contracts | Multicall3 `aggregate3Value` with per-target sub-calls; already the collect-all fast path. Needs: an index, a cross-collection eligibility multicall, per-collection `mintFee` reads |
| **USDC-only sweep, one tx** | ✅ on smart wallets (atomic EIP-5792); ⚠️ N + 1 prompts on legacy EOAs | ERC20Minter `safeTransferFrom(msg.sender)` rules out Multicall3. Bundle = 1 summed approve + N mints |
| **Mixed ETH + USDC sweep, one tx, any wallet** | ❌ not without a Kismet router contract | Nothing shipped can hold the USDC allowance and forward `msg.value` in one tx on an EOA. Feasible via §4.3 E3 |
| **Best-effort sweep (partial success, no revert cascade)** | ⚠️ Only via simulation-before-sign (E1/E2) or a router (E3) | Multicall3 `allowFailure=true` is unsafe with value (§4.4) |
| **Full-catalog "everything" sweep** | ✅ as rounds of ≤ 20 | At the July catalog size (30 public artworks) "everything" is two rounds; the existing "re-click to grab the rest" UX already covers it |
| **Gasless sweep (Kismet sponsors gas)** | ✅ on Base Account / EIP-5792 wallets via ERC-7677 paymaster capability; ✅ server-side via the scout's CDP spender for users who granted a Spend Permission | Cost borne by Kismet; bounded by policy. Optional sweetener, not a requirement |
| **Secondary-market sweep (listings)** | Out of scope here; ✅ natively via Seaport `fulfillAvailableAdvancedOrders` (partial-fill tolerant) | Different verification path (`OrderFulfilled`), different index (`kismetart:listings`) |

---

## 4. Solution space

A sweep has three layers plus a safety layer. Options are labeled D (discovery),
R (ranking), E (execution), S (safety) so the recommendation in §5 can name them.

### 4.1 Discovery — building the candidate pool

| Option | Mechanism | Per-click cost | Freshness | Verdict |
|---|---|---|---|---|
| **D1 On-demand fan-out** | On click, run today's `loadCollectAllEligibility` over every tracked collection (inprocess `/timeline` per collection + `fetchEligibleTokens` ×2) | O(collections) inprocess fetches + ≈ 4 RPC/collection; 30 collections ≈ 30 + 120 calls; seconds of latency | Perfect | ❌ Reproduces B1 at catalog scale. Acceptable only as a one-off admin tool |
| **D2 Registry + one multicall** | Enumerate `scanCreatedMints` (or the census's per-collection walk) → **one** cross-collection multicall (`FPSS.sale`, `ERC20Minter.sale`, `getTokenInfo` per token; `mintFee` per collection) → filter live/paid/not-sold-out → rank | 1 Redis SSCAN (≈ 1 round trip / 1,000 members) + 1–3 chunked `eth_call`s regardless of collection count. Preview metadata (name/image/creator) needs a KV MGET plus, for images, inprocess `/moment` reads or the timeline cache | Perfect | ✅ Correct primitive. Too slow to run unindexed on every click once the catalog is in the thousands (the `getTokenInfo` `uri` payloads dominate), but exactly the right **click-time re-verification** step for a bounded candidate set |
| **D3 Materialized sweep index** | Hourly cron (piggyback on `rebuildCatalogCensus`, which already holds every `Moment` row with metadata) → D2's reads in chunks of ≤ 100 → filter (live, `price > 0`, not sold out, not pass, not hidden ×3, USDC-only for ERC20) → compute `outlayUsd` → persist the cheapest ~200 per currency with preview meta as one bounded JSON blob (`kismetart:sweep-index`, like `kismetart:stats:platform:catalog`) | Serve: 1 Redis GET (+ memoized hide sets, cached ETH/USD). Build: ≈ (3 × moments / chunk) `eth_call`s hourly; one SET | ≤ 1 h stale (plus optional write-through / on-demand rebuild) | ✅ **Recommended.** Same architecture the feeds review prescribes for F2 ("a cron writes hydrated rows to KV; the endpoint reads from KV"). Staleness is acceptable because D2 re-verifies the shortlist at click time |
| **D4 Client-side enumeration** | Browser reads the registry/timeline and multicalls the chain with `NEXT_PUBLIC_BASE_RPC_URL` | Public key does all the work; mobile latency; Mini App WebViews | Perfect | ❌ Exposes the bundled RPC key to heavy reads, slow on phones, duplicates D2 per user |

**Index shape (D3).** One record per candidate, ≈ 200 bytes:

```jsonc
{
  "updatedAt": 1790000000000,
  "ethUsd": 4200.12,                // rate used for outlayUsd at build time
  "eth":  [ { "c": "0x…", "t": "7", "price": "100000000000000",   // wei
              "fee": "111000000000000", "outlayUsd": 0.89,
              "name": "Dawn", "image": "ar://…", "artist": "0x…",
              "collectionName": "Rome 2026", "saleEnd": "0",
              "remaining": null, "maxPer": "0" } ],
  "usdc": [ { "c": "0x…", "t": "3", "price": "500000", "outlayUsd": 0.50, … } ]
}
```

Keeping only the cheapest ~200 per currency bounds the blob (≈ 80 KB) far
below Upstash's request cap and keeps `/api/sweep` a single GET. Artist and
collection identity are resolved at build time with the census's exact
precedence (`resolveMomentCreator` + `getSmartWalletOwners` fold) so the
per-artist cap in §4.2 and the feeds cannot disagree about who made what.

**Freshness levers (D3), cheapest first.** (a) Click-time re-verification (D2
on the shortlist) — mandatory, makes staleness a UX issue rather than a
correctness issue. (b) On-demand rebuild when `/api/sweep` sees an index older
than N minutes, single-flight via `acquireLock`, run in `after()` like the
stats cron. (c) Write-through from `/api/collect`: a recorded collect on a
capped edition can decrement `remaining` in the blob (cheap, approximate).
(d) Write-through from `/api/moments` (`recordSaleEnds` already sees every
resolved price) to drop a member whose price rose or window closed.

### 4.2 Ranking and policy — which N

| Option | Rule | Pros | Cons |
|---|---|---|---|
| **R1 Pure cheapest-N** | Sort by `outlayUsd` ascending, take N | Matches the words of the request | Gameable: one artist lists twenty $0.10 pieces and every sweep is that artist. Directly undermines "a wide variety of art and artists" |
| **R2 Cheapest-N with a per-artist cap** | R1, but at most `k` per resolved artist (default `k = 1`), then fill | Encodes the stated goal; still cheap-first | Needs creator resolution in the index (already available from the census pipeline) |
| **R3 Price floor + per-artist cap** | R2 plus `outlayUsd ≥ floor` (e.g. $0.50) | Excludes dust priced to farm sweep slots; keeps the basket meaningful to artists | Another knob to explain; floor must track ETH/USD |
| **R4 Budget-bounded** | "Sweep up to $X": take cheapest-first (with R2/R3) until the budget is spent | Matches how collectors think; the scout already has this budget math | Different button semantics than "N pieces" |

Cross-currency comparison needs `getEthUsd()` (Chainlink, cached 60 s, refuses
answers older than 2 h). When it returns `null`, follow the repo's "honest USD"
rule: fall back to a single-currency sweep rather than guess a rate.

Tie-breaks and secondary signals worth considering: newest first (rewards fresh
work), or a deterministic rotation seeded by the hour (the scout's `fairOrder`
does this per drop) so two collectors sweeping the same minute don't chase the
same scarce edition.

### 4.3 Execution — how the basket lands on-chain

| Option | One tx? | Wallets | Currencies | Partial failure | New contract? | Verdict |
|---|---|---|---|---|---|---|
| **E1 Multicall3 `aggregate3Value`** (today's ETH fast path) | ✅ always | Any (plain `eth_sendTransaction`) | ETH only | ❌ atomic (`allowFailure=false`; see S1 for why it must stay false) | No | ✅ **Phase 1** |
| **E2 EIP-5792 `wallet_sendCalls`** (today's mixed path) | ✅ on atomic wallets; ❌ N prompts on legacy EOAs | Coinbase Smart Wallet / Base Account (atomic); MetaMask post-Pectra (EIP-7702, atomic after upgrade); others → sequential fallback | ETH + USDC | Atomic wallets: all-or-nothing; sequential: per-tx | No | ✅ **Phase 2** (already implemented; reuse `buildCollectBatchPlan`) |
| **E2+ Paymaster-sponsored E2** | ✅ | Wallets honoring the ERC-7677 `paymasterService` capability | ETH + USDC | as E2 | No (paymaster config) | Optional sweetener; Kismet pays gas |
| **E3 Kismet "sweep router" contract** | ✅ always | Any | ETH + USDC in one tx (router holds a one-shot USDC allowance, forwards partitioned `msg.value`) | ✅ per-item `try/catch` with end-of-call refunds of unused ETH/USDC | **Yes** — the first Kismet-owned contract | ⚠️ **Phase 3, data-driven.** Audit, deploy, verify, upgrade story, a new USDC approval target for users, and a value-holding contract to secure. Buys exactly two things E1+E2 lack: mixed-currency single-tx on EOAs, and best-effort semantics |
| **E4 Server-executed via Spend Permission** (scout spender) | ✅ one atomic CDP userOp, gas sponsored | Only smart-wallet users who granted a Spend Permission to the scout | ETH or USDC (the permission's token) | Atomic per userOp | No | Niche: turns "sweep" into an agent action ("sweep the cheapest 10 whenever my budget refills"). Reuses `collectViaSpendPermission`; today it submits one candidate per op, so a multi-item op is a small extension of `composeScoutCollect` |
| **E5 Agent Actions envelope** | n/a (agent signs) | Base MCP / any agent | ETH + USDC | as the agent's wallet | No | ✅ Free: `/api/sweep` returns the same `AgentActionEnvelope` as `prepare-collect-batch`; add a `discover?kind=sweep` row type |

Wallet-support notes, with confidence:

- Base Account / Coinbase Smart Wallet: atomic EIP-5792 — **high** (the agent
  eligibility gate `hooks/useSmartWalletAgentEligibility.ts` relies on it).
- MetaMask: EIP-5792 with an EIP-7702 upgrade prompt — **high** (the hook's own
  comment: "MetaMask post-Pectra").
- Farcaster Mini App host wallet: the wagmi connector proxies `request` to the
  host provider; whether the host answers `wallet_sendCalls` atomically could
  **not be verified from this environment** (docs host blocked). E1 sidesteps
  the question for ETH-only sweeps, which is one more reason to ship it first.
- Everything else: the existing sequential fallback (`N` prompts) is the floor.

### 4.4 Safety between preview and signature

| Option | What it does | Cost | Verdict |
|---|---|---|---|
| **S1 Keep `allowFailure=false`** | Any inner revert undoes the whole batch; the user is never partially charged | — | ✅ Mandatory. **Verified against Multicall3 source:** with `allowFailure=true`, a reverting value-carrying sub-call leaves its `value` in Multicall3 (the failed `call{value}` returns the ETH to the *caller frame*, which is Multicall3); the contract has no withdraw and no `receive`, and every `aggregate3Value` requires `msg.value == Σ value`, so that balance is unspendable — **stranded forever** |
| **S2 Click-time re-verification (D2 on the shortlist)** | Fresh `sale`/`getTokenInfo`/`balanceOf` for ≈ 3N candidates in one multicall; rank; take N | 1–2 `eth_call`s | ✅ Mandatory (today's collect-all does the per-collection equivalent) |
| **S3 Simulate the exact bundle before prompting** | `eth_call` the Multicall3 bundle with `allowFailure=true` and `from = account, value = total`; read per-call `success`; drop failures; rebuild with `allowFailure=false`; prompt. (Simulation can never strand funds — it is not a transaction) | 1 `eth_call` (+ 1 more per retry, bounded to 2) | ✅ Strongly recommended — this is what converts B3 from "the batch fails" into "the batch shrinks". For USDC legs, simulate each `ERC20Minter.mint` with `from = account` (a handful of `eth_call`s), or rely on S2 |
| **S4 Balance pre-check** | Read `getEthBalance(account)` and `USDC.balanceOf(account)` in the S2 multicall; refuse or auto-trim the basket to what the wallet affords (cheapest-first trims naturally) | 0 extra calls | ✅ Cheap, avoids a guaranteed revert and a confusing wallet error |
| **S5 Price-drift guard** | FPSS/ERC20Minter enforce strict value/`totalValue` equality, so a price change between S2 and mining reverts rather than overcharges (documented in `buildEthMintCall`). S3 catches most of the window | — | ✅ Inherent; document, don't build |
| **S6 Mint-fee sanity bound** | `readMintFeeWithBound` refuses `mintFee > 0.01 ETH` per collection. For a sweep, read every collection's `mintFee()` in one multicall and apply the same bound per row | 0 extra round trips | ✅ Keep; extend to a batched reader |
| **S7 Treasury invariants** | Every call must come from `buildEthMintCall` / `buildUsdcMintCall` (Kismet referral + strategy address). Extend `scripts/verify-agent-collect-batch.ts`-style oracles to the sweep builder | — | ✅ Mandatory; the repo's own "treasury-critical" rule |

---

## 5. Recommended architecture

**Phase 1 — ETH-only (or single-currency) sweep, no new contracts.**
D3 index + D2 re-verification + R3 policy + E1 execution + S1–S7.

```
                   hourly (sync-stats cron, after the census)
  tracked collections ──▶ catalog walk (already in memory) ──▶ chunked multicall
       (kismetart:collections)     every Moment row             FPSS.sale · ERC20Minter.sale ·
                                                                getTokenInfo · mintFee/collection
                                        │
                                        ▼
                        filter: live · price>0 · not sold out · not pass ·
                                not hidden(×3) · USDC-only for ERC20
                        rank:   outlayUsd (Chainlink) · per-artist cap · floor
                        keep:   cheapest ~200 / currency + preview meta
                                        │
                                        ▼
                         SET kismetart:sweep-index  (one bounded JSON blob)

  ── click "sweep" ─────────────────────────────────────────────────────────────
  GET /api/sweep?n=20&currency=eth  ──▶  1 Redis GET · hide sets (memoized) ·
        public, s-maxage=30              cached ETH/USD · returns top ~3N + totals
                                        │
                                        ▼
  client (hooks/useSweep):  drop already-collected (collected list) ──▶
        S2: ONE multicall  [sale, getTokenInfo, balanceOf] × 3N + mintFee × collections
                           + getEthBalance + USDC.balanceOf
        rank again · per-artist cap · take N · S4 trim
        build via buildCollectBatchPlan (cross-collection, treasury builders)
        S3: eth_call Multicall3(allowFailure=true) → drop failures → rebuild strict
                                        │
                                        ▼
        SweepSheet: N cards (image · artist · price) · total Ξ and $ · remove toggles
                                        │  confirm
                                        ▼
        E1: writeContract Multicall3.aggregate3Value (allowFailure=false, dataSuffix)
        wait receipt ──▶ POST /api/collect × N (60/min budget) ──▶ toast
```

**Phase 2 — mixed baskets.** Same pipeline; when the ranked N contains USDC
items, dispatch through the existing EIP-5792 branch (`useCollectAll`'s
sequential fallback included). Product copy must be honest on legacy EOAs
("confirm 11 prompts"), or the sheet can offer "ETH only" / "USDC only"
toggles that keep the single-signature promise.

**Phase 3 — optional router contract (E3).** Only if analytics show meaningful
demand for mixed sweeps from EOA wallets, or best-effort semantics prove
necessary despite S3. Scope it as a minimal, non-upgradeable, balance-less
router: `sweep(items[], mintTo, usdcTotal, deadline) payable`, per-item
`try/catch`, refund leftovers at the end, events per item; keep the Zora
referral and builder-code attribution.

**Parallel, cheap wins.** Expose `/api/sweep` as an agent envelope (E5); add
funnel events (`sweep_open`, `sweep_attempt`, `sweep_success`); consider a
`POST /api/collect/batch` so one receipt fetch verifies all N records instead
of N receipt fetches of the same tx.

**Why this order.** Phase 1 removes B1/B5 with one index, keeps the
single-signature promise on every wallet, needs no new trust surface, and
reuses the dispatch/attribution/recording code that has already absorbed the
production incidents (wallet recovery, stuck receipts, partial-record loss).
Phase 2 is a flag flip on code that already runs for collections. Phase 3 is
the only step with a new security surface, so it should be a data-driven
decision, not a launch requirement.

---

## 6. Cost model

| Cost | Today (collect-all, one collection) | Sweep, D1 naive | Sweep, D3 + D2 (recommended) |
|---|---|---|---|
| Inprocess fetches per click | 0 (candidates come from the page) | ≥ 1 per tracked collection (30–250) | **0** (index built hourly) |
| RPC calls per click (server) | 0 | ≈ 4 per collection | 0 (index read) |
| RPC calls per click (client) | 2 currencies × (getBlock + 2 multicalls) ≈ 6 | same × collections | **≈ 3**: one S2 multicall (may chunk to 2), one S3 simulation |
| Redis commands per click | few (`/api/collect` ×N) | few | **1 GET** + `/api/collect` ×N (existing) |
| Index build (hourly) | — | — | ≈ 3 reads/moment chunked at 100 → for 2,000 moments ≈ 60 `eth_call`s + 1 SET + the census walk it already piggybacks |
| Gas (user) | ≈ 250k/mint (repo estimate); 20 → ≈ 5M | same | same; Base execution gas is cents at this size — the 20 cap is about preview readability, per the code comment |
| Protocol fee (user) | 0.000111 ETH per ETH mint (Kismet earns the mint-referral share) | same | same; a 20-piece ETH sweep is 0.00222 ETH of fees, which is why fee-inclusive ranking matters below ≈ $1 |
| Upstash budget impact | — | — | negligible against the ~1M commands/month baseline in `STACK_OVERVIEW.md` |

---

## 7. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Atomic revert cascade (one of 20 sales closes between preview and mining) | Medium, grows with N and with sale diversity | S2 + S3; keep N ≤ 20; show "sweep again" for leftovers |
| Stranded ETH via `allowFailure=true` | Only if someone "optimizes" S1 away | Regression comment on the batch builder + a verifier that asserts `allowFailure === false` on every value-carrying call |
| Sweep-slot farming (dust-priced pieces dominate) | High once the button exists | R2/R3 defaults; hide sets remain the moderation backstop |
| Cross-currency mis-ranking when Chainlink is stale | Low | Single-currency fallback when `getEthUsd()` is `null` |
| Sequential fallback on legacy EOAs surprises users with N prompts | Medium on web | Detect `wallet_getCapabilities` up front; offer single-currency baskets; copy that states the prompt count (the hook already does) |
| Index staleness shows a sold-out piece in the preview | Medium | S2 re-verification before the sheet renders; on-demand rebuild trigger |
| `/api/collect` 429 on a 20-item sweep from a shared NAT | Low (limit sized for 20) | Batch record endpoint; bounded retry already exists in `useDirectCollect` — port it to the sweep recorder |
| `getTokenInfo` payloads blow up the index multicall | Low | Chunk ≤ 100 rows per `eth_call` (the feeds cap at 80/240 for this reason) |
| Non-inprocess FPSS deployments read as zeros | Known, fail-safe | Excluded (no sale row); tracked as a product gap in `lib/zoraMint.ts` |
| Pass collection or hidden work in a sweep | Must not happen | Same exclusions as the census, applied at build **and** at serve time (hide sets are memoized 15 min) |
| Router contract (Phase 3) holds funds mid-tx | Inherent to E3 | Refund-at-end, no persistent balances, reentrancy guard, audit; treat as a separate security review |

---

## 8. Implementation delta (for sizing, not for this PR)

| Layer | New / changed | Notes |
|---|---|---|
| Index | `lib/sweepIndex.ts` (build + read), hook into `app/api/cron/sync-stats/route.ts` after the census; reuse the census walk output | Reuse `resolveMomentCreator`, `getSmartWalletOwners`, hide-set readers, `getEthUsd`, `acquireLock` |
| Chain reads | `lib/saleConfig.ts`: `fetchEligibleTokensMulti(items[], account?)` — the cross-collection generalization of `fetchEligibleTokens` (one multicall for `sale` ×2 + `getTokenInfo` + `balanceOf`), and `readMintFeesWithBound(collections[])` | `resolveOnchainSalesBatch` is the template |
| API | `app/api/sweep/route.ts` (`n`, `currency`, `floor`, `perArtist`; `public, s-maxage=30`); agent envelope variant | Rate-limit like `agent-discover` (60/min per IP) |
| Client | `hooks/useSweep.ts`; extract `useCollectAll`'s dispatcher (Multicall3 / 5792 / sequential + attribution + recording) into a shared module both hooks use | The dispatcher is ≈ 250 lines of incident-hardened code; do not fork it |
| UI | `components/SweepSheet.tsx` (preview, totals, remove toggles); an entry point on Discover (`DiscoverPage` main/trending header, next to the sort pills) | Mobile-first (Mini App) |
| Simulation | `lib/sweepSimulate.ts`: `eth_call` the `allowFailure=true` bundle, map failures back to items | Pure mapping is unit-testable |
| Verifiers | `scripts/verify-sweep.ts`: ranking policy (fee-inclusive, per-artist cap, floor), `allowFailure=false` on the strict bundle, treasury constants on every call | Matches the repo's oracle pattern |
| Docs | `STACK_OVERVIEW.md` §4.2 collect flow; `ANALYTICS.md` funnel events | — |

Rough size: Phase 1 ≈ 1,200–1,600 lines including verifiers; Phase 2 ≈ 100
lines (branch already exists); Phase 3 is a separate Solidity project.

---

## 9. Decisions only the team can make

1. **Basket size and shape:** fixed N (10 / 20), a slider, or a budget ("sweep
   up to $25")? Recommendation: default 10, max 20, with a budget cap shown.
2. **Currency policy for the single-signature promise:** ETH-only by default
   with a USDC toggle (R3 + E1/E2), or mixed baskets from day one (E2, with
   N-prompt fallback on legacy EOAs)?
3. **Fee-inclusive ranking:** rank on outlay (recommended) or on sticker price
   (simpler to explain, mis-ranks sub-$1 ETH mints)?
4. **Per-artist cap** (recommended 1) and **price floor** (recommended ≈ $0.50):
   both are anti-farming and pro-diversity, both change which pieces a sweep
   picks. Also: per-collection cap?
5. **Definition of "minted on Kismet":** created-mints registry (strict, what
   the Mints tab means) or any tracked collection (what Collections means)?
   Recommendation: tracked collections minus the pass, i.e. the census set.
6. **Atomic vs best-effort:** accept "the sweep shrinks or fails as a whole"
   (E1/E2 + S3) or fund a router contract for partial success (E3)?
7. **Placement and naming:** a Discover-level "sweep" pill, a home-feed CTA,
   both? "Sweep" is a marketplace word (floor sweeps); "collect a sampler" or
   "one of each" may read better for a primary-mint product.
8. **Gas sponsorship:** should Kismet pay gas for sweeps on Base Account
   wallets (E2+)? It is a marketing cost with a clear per-sweep ceiling.
9. **Agent exposure:** ship the agent envelope in Phase 1 (cheap) or hold it?

---

## 10. Validation record

**Verified against source in this repository** (file + symbol): the collect-all
dispatch branches and cap (`hooks/useCollectAll.ts`, `MAX_COLLECT_ALL_BATCH`);
the Multicall3 rationale and the USDC `msg.sender` constraint
(`lib/zoraMint.ts` `buildMulticall3Batch`); per-collection eligibility cost
(`lib/saleConfig.ts` `fetchEligibleTokens`; `FEEDS_REVIEW.md` F2); the
cross-collection price multicall (`resolveOnchainSalesBatch`); the agent basket
builder and its 20 cap (`lib/agent/collectBatch.ts`,
`app/api/agent/prepare-collect-batch/route.ts`); the scout's one-of-each and
fee-inclusive cap (`lib/agent/scout/serverExecutor.ts`); the hourly census walk
and its exclusions (`lib/catalogCensus.ts`, `app/api/cron/sync-stats/route.ts`);
the sale-end / free-mint write-through indexes (`lib/saleEnds.ts`); the
created-mints registry and off-platform admission (`lib/kv.ts`,
`lib/feedAdmission.ts`, `app/api/timeline/route.ts`); the `/api/collect` rate
limit sized for a 20 batch (`app/api/collect/route.ts`); the Chainlink rate
reader (`lib/ethPrice.ts`); the July 2026 catalog snapshot (`ANALYTICS.md` §7).

**Verified against external source:** Multicall3 `aggregate3Value` semantics
(revert only when `allowFailure` is false *and* the call failed; `msg.value`
must equal the summed values; no withdraw/receive) — read from
`mds1/multicall` `src/Multicall3.sol`.

**Not verifiable from this environment, stated with hedges above:** whether the
Farcaster Mini App host wallet executes `wallet_sendCalls` atomically (the
docs host is blocked from this sandbox; the installed connector merely proxies
`request`); today's live catalog size (the July snapshot is the latest number
in the repo); exact per-mint gas on Base (the repo's own ≈ 250k estimate is
used throughout).
