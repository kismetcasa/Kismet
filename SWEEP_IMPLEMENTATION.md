# Sweep (ETH-only) — Implementation Design

**Date:** 2026-09-26 · **Status:** IMPLEMENTED behind `kismetart:sweep-enabled` (default
off). The build: `lib/sweepIndexCore.ts` + `lib/sweepRank.ts` + `lib/sweepIndex.ts` (the
hourly index, §2), `app/api/sweep/route.ts` + `app/api/admin/sweep/route.ts` (§3),
`lib/saleConfig.ts` `fetchEligibleTokensMulti` + `lib/sweepBatch.ts` + `lib/sweepSimulate.ts`
+ `lib/sweepVerify.ts` (§4), `hooks/useSweep.ts` + `components/SweepSheet.tsx` +
`components/SweepButton.tsx` mounted in `components/DiscoverMarketView.tsx` (§5), and the
checks in §7 (`verify:sweep` and `verify:sweep-index` in `npm run check`, a section of the
routes harness, a browser script). One deviation from the text
below as first written: the sheet formats ETH through the existing `formatPrice`, so
nothing was moved out of `CollectAllAction`.
**Scope:** collect one edition each of the cheapest N (default 10, max 20) **ETH-priced**
mints live on Kismet, in **one transaction on any wallet**. USDC-priced (ERC20Minter) work is
out of scope by decision; §0 keeps the alternatives that were weighed and why they lost.

**To turn it on:** deploy → `GET /api/cron/sync-stats?secret=…` once (or wait for the hour)
→ `GET /api/admin/sweep` shows `index.pool > 0` → `POST /api/admin/sweep {"enabled":true}`.
Until then `/api/sweep` answers `{ enabled: false }` and the button does not render.

> **Scope in one line.** FixedPriceSaleStrategy sales on Base only → one
> Multicall3 `aggregate3Value` transaction → `/api/collect` records, exactly
> the primitives the per-collection collect-all already ships. Everything new
> is on the **discovery** side (a materialized index) and the **safety** side
> (verify + simulate before the wallet prompt).

---

## 0. Scope: what the ETH-only decision removes, and the alternatives considered

| Concern | Mixed-currency alternative (not built) | ETH-only (this doc) |
|---|---|---|
| Execution path | Multicall3 **or** EIP-5792 `wallet_sendCalls` with a sequential fallback | **Multicall3 only** (plain `eth_sendTransaction`); N = 1 falls back to the direct `1155.mint` |
| Wallet dependency | Atomic EIP-5792 support decides "one signature" on smart wallets; N prompts on legacy EOAs; Farcaster host wallet unverified | **None.** Every wallet in `lib/wagmi.ts` (RainbowKit set, Farcaster Mini App connector, Coinbase WebView `injected`) sends a plain transaction |
| USDC approve / allowance | Summed approve, allowance read, approve-failure short-circuit | Gone |
| Cross-currency ranking | Chainlink ETH/USD normalization, single-currency fallback when stale | Gone from ranking; ETH/USD used **only for the "≈ $" label** (`hooks/useEthUsd.ts`) |
| Atomicity | All-or-nothing on atomic wallets, per-tx on sequential ones | All-or-nothing, mitigated by pre-flight simulation (§4.3) |
| Chain reads at click | Two strategies × N | **FPSS only**: `sale` + `getTokenInfo` + `balanceOf` per item, `mintFee` per collection, one balance read — one multicall |
| Index | Two pools (eth, usdc) | One pool |

Net effect: the hook is roughly a third of `useCollectAll`'s size, and the only
new on-chain surface is a read-only simulation.

**Alternatives considered** (the feasibility survey that preceded this design, condensed
to what still matters):

| Variant | Verdict | Why |
|---|---|---|
| ETH-only sweep, cheapest N ≤ 20, one tx, any wallet | **Built** | Multicall3 `aggregate3Value` takes a `target` per sub-call, so the cross-collection batch is collect-all's fast path with a different candidate list; no new contracts |
| USDC-only sweep | Deferred | The ERC20Minter pulls USDC from `msg.sender`, so it cannot ride Multicall3; it would ride EIP-5792 as collect-all does — atomic on smart wallets, N + 1 prompts on legacy EOAs |
| Mixed ETH + USDC in one tx on any wallet | Rejected | Needs a Kismet-owned router contract (first contract, audit, ops); the data does not justify it |
| Best-effort batch via Multicall3 `allowFailure=true` | Rejected | Verified against the Multicall3 source: a value-carrying sub-call that reverts under `allowFailure=true` leaves its ETH in Multicall3, which has no withdraw and no `receive` — stranded. Partial-failure tolerance comes from simulating before signing instead (§4.3) |
| Gas sponsorship (paymaster) | Not applicable | Rides EIP-5792, which this design does not use; the user pays cents on Base |
| Secondary-market (listings) sweep | Out of scope | A Seaport `fulfillAvailableAdvancedOrders` path with its own verification and index |
| "Everything" in one go | Rounds of ≤ 20 | The size cap is wallet-preview readability plus `/api/collect`'s per-IP budget; `sweep the next N` covers the rest |
| Per-artist cap / price floor in the ranking | Deferred (§8) | The zero-cost tie-break (artists interleave within a price tier) covers the gaming case; neither is built — either would be a few lines in `rankSweepCandidates` |

---

## 1. Product specification

### 1.1 Entry point

> **Decision (2026-09-26): one `sweep` button, at the top of the advanced
> discover page, nothing else for now.** The advanced discover page is
> `/discover` (`app/discover/page.tsx` → `components/DiscoverMarketView.tsx`,
> whose docblock names it the "advanced market browser"), not the home page's
> tab strip in `components/DiscoverPage.tsx`. The two-pill plan (trending +
> main feed headers) is withdrawn.

Placement: `DiscoverMarketView`'s `stickyHeader` — the control surface
rendered once above whichever market branch is active (sticky under the nav on
`sm+`, in-flow on mobile). The button sits in the header's top row right after
the primary/secondary market toggle, with the stats block pushed to the right
(`ml-auto`); the row wraps (`flex-wrap`), so on a narrow phone the stats block
drops under the toggle and the button instead of squeezing all three. It is the
first thing on the page after the market choice. Styling follows the header's
own `stats` button (rounded-full, `border-line`, mono uppercase, `hover:border-accent`)
but with an accent border and text (`border-accent/40`, `text-accent`) so it
reads as an action rather than a filter; no icon, no `aria-pressed`. Rendered
only while `/api/sweep` answers `enabled: true` with a non-empty pool
(`useSweepAvailable`, one shared react-query with a 60 s stale time);
otherwise nothing renders and the row keeps its two-item layout. Visible in both markets — a resale browser is still a fine place to
offer a primary sweep — but it always opens the same sheet.

### 1.2 The sweep sheet

Tapping the button opens `SweepSheet` — a centered, scrollable card modal in the
`PatronInfoModal` pattern (`role="dialog"`, `useBodyScrollLock`,
`useEscapeKey`, backdrop click closes). Contents, top to bottom:

1. **Header**: `sweep the floor` · subtitle `Kismet patrons always bring a broom`.
   A size toggle `10 | 20`.
2. **Rows** (one per candidate, in rank order): thumbnail (`MomentImage`,
   thumbhash placeholder), artwork name, artist name (enriched the
   same way feed cards are), the live price through `formatPrice`
   (`0.0010 ETH`) + a muted `+ fee` suffix, a remove `×`. A row that
   verification could not put in the bundle shows greyed with its reason and
   is not counted: `sold out, ended, or already yours` · `now a free mint` ·
   `mint fee unreadable` · `not mintable right now` (it failed the simulation)
   · `needs more ETH` (the balance trim, §4.4). A removed row offers `undo`.
3. **Totals**: `N artworks · 0.0123 ETH ≈ $52.00` — the on-chain `value`
   (prices + protocol fees), never a bare price sum, so the wallet prompt and
   the sheet agree to the wei; the `≈ $` part comes from `useEthUsd` and is
   omitted when the rate is unavailable. After a sweep: `swept N artworks ·
   view on basescan`.
4. **Primary button**, one of: `loading…` → `verifying…` (disabled) → `sweep N
   for 0.0123 ETH` → `confirm in wallet…` → `confirming…` → `finalizing…` →
   `sweep the next N` (re-runs discovery, which now excludes what was just
   collected; the success itself is the toast `Swept N artworks!` and the
   totals line). Other states: `retry` after an error, `re-check` on an empty
   pool, `add ETH, then re-check` when nothing is affordable, `connect wallet`
   after a declined connect, `nothing to sweep` when every row was removed.
   The sheet closes on `×`, Escape or the backdrop.
5. **Footnotes**: `one edition each` and the
   count of candidates the wallet balance cannot cover, if any.

### 1.3 States and edge cases

| Situation | Behavior |
|---|---|
| Not connected | The sheet opens at once and runs `useEnsureConnected` (host wallet inside Mini App / Coinbase WebView, RainbowKit modal on web); a declined connect leaves it on `connect wallet`, which re-runs the connect |
| Wrong chain / wallet | Verification is read-only against the Base client, so the wallet is asked to switch only when the user taps sweep (`useEnsureBase`, then a chain guard right before the send, as `useCollectAll`). A wallet **account** switched between verification and the tap is re-verified, never signed for: the ownership, balance and simulation checks were for the other signer |
| Wallet replaces the pending transaction | Success is the receipt SHOWING the mints (one TransferSingle to the user per row), never `status` alone. A speed-up carries the same mints under a new hash → done, recorded under the hash that mined. A cancel mines nothing → error `The transaction was replaced in the wallet — check it before trying again`, nothing marked swept, nothing recorded |
| Receipt wait times out (5 min) | Error. The next open checks that hash once before anything can be re-sent: still pending → `Your last sweep is still pending — check your wallet before trying again`; mined → proceeds, and verification excludes whatever it minted (no double mint) |
| The strict bundle cannot be gas-estimated | Never presented as ready: `Could not verify the sweep on-chain — try again` (an RPC failure or a bundle that would revert), retry re-verifies |
| Pool empty / index missing | Button hidden; if opened via a stale render, the sheet shows `nothing to sweep right now` with a `re-check` button |
| Fewer than N eligible after verification | Sheet shows what is available (`sweep 4 for 0.0042 ETH`); no error |
| Exactly 1 eligible | Direct `1155.mint` built by `buildEthMintCall` in the hook (keeps `Purchased.sender` = user), with the same builder suffix; the sheet still shows one row |
| Balance short | Trim to the cheapest affordable prefix (§4.4); the rows show `needs more ETH` and the footnote counts them; if zero affordable, the button reads `add ETH, then re-check` |
| Simulation drops rows | Refill from the ranked reserve and re-simulate (≤ 2 rounds); dropped rows stay visible, greyed, with reason |
| Bundle reverts on-chain (a 1/1 minted by someone else between simulation and mining) | Error toast `Sweep reverted on-chain — nothing was charged`; the button reads `retry`, which re-verifies and drops the culprit |
| User rejects in wallet | Existing `isUserRejection` handling via `useWalletRecovery` (`sweep` toast id) |
| Record POSTs fail | Bounded retry (5, backoff ≈ 6 s in all, `keepalive`) then `reportClientError('sweep.record_failed')`; success toast still shows because the mint landed |
| Wants more than 20 | `sweep the next N` rounds; the cap stays `MAX_COLLECT_ALL_BATCH` (wallet-preview readability) |

### 1.4 Copy rules

The sheet's copy is the brand's, not a spec: `sweep the floor` / `Kismet
patrons always bring a broom`, and a footnote of `one edition each` (plus the
count of rows the wallet cannot cover). The ETH-only scope is a product
decision recorded here (§0, §8), not something the sheet has to announce.
The sheet, not the wallet, is the trust surface, so it must show the exact
`value` and every recipient artwork before the prompt.

---

## 2. The sweep index

### 2.1 Source: reuse the census walk

`lib/catalogCensus.ts` `runCensus` already does, hourly, everything the index
needs except chain reads: walks every tracked collection's timeline (200 per
page, ≤ 20 pages, concurrency 6), dedups by `collection:tokenId`, skips the
Patron collection, resolves each moment's creator with the platform-wide
precedence (`resolveMomentCreator` → KV `MomentMeta.creator` over the feed's
attribution) plus the smart-wallet → EOA fold (`getSmartWalletOwners`), and
computes the hidden verdict with the timeline's three filters.

**Refactor** (mechanical, no behavior change to the census):

```ts
// lib/catalogCensus.ts
export interface ResolvedCatalogItem {
  m: Moment              // full inprocess row (metadata inlined)
  addr: string           // effective collection, lowercased
  creator: string | null // resolved (KV override over the feed), lowercased — the display identity
  artist: string | null  // `creator` folded to the owning EOA — the diversity identity
  hidden: boolean        // moment-hidden | hidden collection | admin-hidden creator
  meta: MomentMeta | null // the KV moment-meta row (creator override, pinned createdAt)
}
export interface ResolvedCatalog {
  items: ResolvedCatalogItem[]
  collections: string[]  // scanned set (patron excluded)
  possiblyTruncated: number
  pageFailures: number
}
async function resolveCatalog(): Promise<ResolvedCatalog>          // walk + dedup + attribution + fold + hidden
export function censusFromCatalog(cat: ResolvedCatalog, updatedAt: number): CatalogCensus  // the pure counting half
export async function rebuildCatalogCensus():
  Promise<{ census: CatalogCensus; catalog: ResolvedCatalog } | { skipped: true }>
```

`rebuildCatalogCensus` keeps its lock, its abort-on-unreadable-collection
throw, and its shrink guard; it additionally returns the resolved catalog so
the cron can hand it to the index builder **without a second walk**. The
cron (`app/api/cron/sync-stats/route.ts`) becomes:

```
rebuildStats() → rebuildCatalogCensus() → rebuildSweepIndex(catalog) → reconcilePendingCredits()
```

each in its own try/catch and each recorded through `recordStatsRun` (extend
`StatsPhase` in `lib/statsHealth.ts` with `'sweep-index'` so the
`/api/admin/stats-health` endpoint reports index age and last error — ✏️ there
is no dashboard panel; it is the JSON ops read an uptime monitor points at.
The sweep phase gets its own `sweepHealthy` verdict rather than folding into
`healthy`, so a sweep-only failure never pages the stats pipeline and vice
versa).

### 2.2 Chain reads (two passes, chunked)

`lib/sweepIndex.ts` `rebuildSweepIndex(catalog)`:

1. **Candidates** = `catalog.items` where `!hidden`,
   `addr !== PATRON_COLLECTION_ADDRESS`, `isAddress(addr)` and
   `isValidTokenId(m.token_id)` (a malformed row is skipped, never allowed to
   abort every rebuild), deduped by `collection:tokenId` with the id canonicalized.
2. **Pass 1 — sale rows.** One `FPSS.sale(addr, id)` per candidate
   (`FPSS_SALE_ABI`), chunked **200 candidates per call** through
   `aggregate3Strict` (`lib/saleConfig.ts`) — ✏️ not viem's `multicall`
   action: with `allowFailure: true` that action flattens a *rejected chunk*
   (an RPC-level failure) into per-call failures, so a transient blip would
   read as "every row unreadable" and overwrite a good index with an empty
   one. `aggregate3Strict` calls Multicall3 `aggregate3` directly: a reverting
   row is `success: false` (skipped), an RPC failure **throws** and the rebuild
   aborts with the last good blob intact. Keep rows with `saleEnd !== 0n`, `saleStart <= now`,
   `saleEnd > now`, `pricePerToken > 0n` — the exact `fetchEligibleTokens`
   window rule, plus the paid rule. `now` = latest block timestamp, as there.
   This pass is cheap (fixed-size structs, no strings) and typically discards
   most of the catalog (free, ended, USDC-priced, unset).
3. **Pass 2 — supply + fees**, only for pass-1 survivors: `getTokenInfo(id)`
   per survivor chunked **≤ 100 per call** (each row carries a `uri` string —
   the same reason the feeds cap supply reads at 80/240), plus `mintFee()`
   once per distinct collection among the survivors. Drop sold-out capped
   editions (`classifyTokenSupply(...).soldOut`); an unreadable or reverting
   supply row counts as open, as every other mintability read does. Drop every token of a collection whose
   `mintFee` exceeds the `readMintFeeWithBound` bound (fail-closed per
   collection, never per run) — the batched reader
   `readMintFeesWithBound(client, collections[])` lives in `lib/saleConfig.ts`
   beside the other chain reads and imports the bound
   (`MAX_REASONABLE_MINT_FEE_WEI`, ✏️ previously module-private, now exported)
   from `lib/zoraMint.ts` so the constant stays single-source.
4. **Outlay** `outlayWei = pricePerToken + mintFee` — the exact `value`
   `buildEthMintCall` will put on the sub-call.

### 2.3 Ranking

Sort ascending by `outlayWei`. Tie-break, in order: **distinct artist first**
(a stable pass that, within a price tier, interleaves artists so the first N
of a tier never come from one wallet), then newest `created_at` (KV-pinned
`MomentMeta.createdAt` beats the feed's, as the timeline does). Implemented
as a pure function:

```ts
// lib/sweepRank.ts (pure, no I/O — verifier target); the string-wei adapter,
// the admission rule and the pool cut live in lib/sweepIndexCore.ts
export function rankSweepCandidates<T extends RankableSweepItem>(items: readonly T[]): T[]
```

No cap and no floor: both were weighed and not built (§8). Either would be a
few lines in this function if the data ever calls for it.

### 2.4 Record shape and persistence

```ts
// lib/sweepIndexCore.ts (the pure half; lib/sweepIndex.ts, the I/O half, imports it)
export interface SweepIndexItem {
  address: string        // collection, lowercased
  tokenId: string        // decimal, BigInt-canonical
  priceWei: string       // FPSS pricePerToken
  feeWei: string         // that collection's mintFee()
  outlayWei: string      // price + fee (the sort key)
  creator: string | null // resolved (KV override over the feed) — the display identity
  artist: string | null  // creator folded to the owning EOA — the diversity identity (§2.3)
  createdAt: string | null
  // Moment-shaped preview fields so /api/sweep can run the feed's identity
  // enrichment (enrichMomentsWithKismetMeta) unchanged; the sheet reads only
  // the username from that overlay.
  name?: string
  image?: string
  thumbhash?: string
}
export interface SweepIndex {
  updatedAt: number
  /** Live, paid, ETH-priced, visible candidates found (before the pool cut). */
  eligible: number
  /** Cheapest POOL_SIZE after ranking. */
  items: SweepIndexItem[]
}
export const SWEEP_INDEX_KEY = 'kismetart:sweep-index'   // lib/redis.ts, with SWEEP_ENABLED_KEY, beside SALE_ENDS_KEY
export const SWEEP_POOL_SIZE = 120                       // 6 × MAX_COLLECT_ALL_BATCH (lib/sweepIndexCore.ts)
```

One `redis.set(SWEEP_INDEX_KEY, index)` per rebuild (≈ 30–40 KB at the pool
cap; a single JSON blob like `kismetart:stats:platform:catalog`, read with the
same `typeof raw === 'string' ? JSON.parse(raw) : raw` guard plus a shape check —
`updatedAt` a number, `items` an array — else null). No shrink
guard: unlike the census, the pool legitimately shrinks as sales end. The
walk's abort-don't-overwrite still applies upstream: an unreadable collection
throws in `rebuildCatalogCensus` and the index build never runs, so a sick
upstream leaves the last good pool in place.

### 2.5 Freshness

| Lever | Cost | Lag it removes |
|---|---|---|
| **Hourly rebuild** (cron) | The census walk it already piggybacks + ≈ (candidates / 200) + (survivors / 100) + 1 `eth_call`s | Discovers new mints and price edits within ≤ 60 min |
| **Click-time verification** (§4.1–4.4) | One aggregate, the fee read, ≤ 3 simulations and one gas estimate per open | Makes staleness a UX matter, never a correctness one — this is the guarantee |
| **Pool refresh on read** (optional, v1.1) | When `/api/sweep` sees `updatedAt` older than 10 min: re-run pass 2 over the pool only (≤ 120 rows, chain-only, no inprocess), single-flight via `acquireLock`, in `after()` | Removes sold-out / ended rows from the pool between rebuilds so the sheet rarely shows greyed rows |
| **Append on mint** (optional, v1.1) | In `lib/mint-proxy.ts`'s post-mint hook (next to `markCreatedMint`), push the new token into the pool if it is ETH-priced and cheaper than the pool's tail | A fresh drop becomes sweepable immediately instead of at the next hour |

`/api/sweep` must never trigger the **walk** (it fans out to inprocess); only
the chain-only refresh is safe to hang off a public read.

---

## 3. `GET /api/sweep`

```
GET /api/sweep?n=10            n ∈ [1, 20], default 10
→ 200 {
    enabled: true,
    updatedAt: 1790000000000,    // null before the first build
    eligible: 37,
    maxN: 20, n: 10,
    items: (SweepIndexItem & {   // top max(3n, 30) after serve-time filters
      creatorProfile: { username },                 // from enrichment
    })[]
  }
→ 200 { enabled: true, updatedAt, eligible: 0, items: [] }  // no build yet, or a pool
                                 // older than SWEEP_INDEX_MAX_AGE_MS (24 h): the button hides
→ 200 { enabled: false }         // flag off (cached 30 s) — or, uncached, on a flag-read failure
→ 503 { error }                  // hide sets unreadable: fail CLOSED, never serve unfiltered
Cache-Control: public, s-maxage=30, stale-while-revalidate=120
```

Route rules (`app/api/sweep/route.ts`):

- `checkRateLimit('sweep:' + ip, 60, 60)` (same budget as `agent-discover`).
- **Flag**: `kismetart:sweep-enabled` — ✏️ named like the existing flags
  (`kismetart:platform:paused`, `kismetart:scout-killswitch`) and read through
  `lib/gateFlags.isFlagSet`, because Upstash JSON-parses a stored `'1'` back to
  the number `1` (the bug that once made the platform-pause flag never
  persist). `'1'` = on, absent = off (the launch default); memoized 60 s;
  fails **closed** on a Redis error. Toggled by `POST /api/admin/sweep`
  (`{ enabled }`, admin session + audit log, the `scout-killswitch` shape);
  `GET /api/admin/sweep` also reports the index snapshot so an operator can
  confirm a build has run before enabling. No deploy needed to pause.
- **Serve-time hide filter**: re-apply `getHiddenMomentsSet`,
  `getHiddenCollectionsSet`, `getHiddenUsersSet` (memoized, 15 min) so a piece
  hidden after the hourly build disappears within 15 minutes, not 60.
- **Enrichment**: run `enrichMomentsWithKismetMeta` over the returned rows
  (mapped to the `Moment` shape) for the artist username, exactly like
  `app/api/featured/collections-hydrated`. Hidden-identity scrubbing rides
  along.
- **No account parameter.** The response is viewer-independent so it caches;
  "already yours" is decided on the client from the balance multicall.
- Optional (v1.1): `?agent=1` returns the same rows plus an
  `AgentActionEnvelope` built by `buildCollectBatchPlan` with `usdcAllowance:
  0n` and ETH items only — the Base MCP path gets "sweep" for the cost of one
  branch, and `references/discover.md` gains a `kind=sweep` row.

---

## 4. Chain helpers

### 4.1 `fetchEligibleTokensMulti` — the cross-collection verification read

```ts
// lib/saleConfig.ts
export interface EligibleTokenRef { collection: Address; tokenId: bigint }
export interface EligibleTokenMulti extends EligibleToken { collection: Address }
export interface EligibleTokensMultiResult {
  items: EligibleTokenMulti[]
  /** Multicall3.getEthBalance(account) from the same aggregate; null = the aggregate itself failed. */
  ethBalance: bigint | null
}
export async function fetchEligibleTokensMulti(
  client: AnyClient,
  refs: readonly EligibleTokenRef[],
  account: Address,
  excludeOwnedAtOrAbove: bigint = 1n,     // "one of each"
): Promise<EligibleTokensMultiResult>
```

One aggregate (`allowFailure` on per slot, a single `eth_call` — the verifier
pins that viem does not re-batch it), **three slots per ref** —
`FPSS.sale(collection, id)`, `collection.getTokenInfo(id)`,
`collection.balanceOf(account, id)` — plus a trailing
`Multicall3.getEthBalance(account)` slot (`MULTICALL3_BALANCE_ABI`) so the
balance pre-check costs no extra round trip. Semantics are **identical** to
`fetchEligibleTokens` (window rule from chain time, sold-out rule,
per-wallet cap, fail-closed per row on a failed balance read, the
`excludeOwnedAtOrAbove` skip): the per-row decision is the shared pair
`classifyOnchainSaleWindow` / `classifyTokenSupply` that `fetchEligibleTokens`
calls too, so the two cannot drift and `scripts/verify-sweep.ts` pins them
with synthetic rows. A null `ethBalance` means the aggregate failed and the
caller reports "could not verify", never "nothing eligible". The ETH-only
sweep never reads the ERC20Minter.

`readMintFeesWithBound(client, collections[])` (in `lib/saleConfig.ts`,
shipped with the index) is a second, smaller aggregate: one `mintFee()` per
distinct collection, returning a map. A collection whose fee is unreadable or
over `MAX_REASONABLE_MINT_FEE_WEI` is simply absent from the map, never
thrown; each consumer drops its rows (the index builder through
`buildSweepItem`, verification with the reason `mint fee unreadable`).

### 4.2 Building the bundle

```ts
// lib/sweepBatch.ts (pure — verifier target)
export interface SweepBasketItem { address: Address; tokenId: bigint; priceWei: bigint; feeWei: bigint }
export interface SweepCall { to: Address; data: Hex; value: bigint }
export const SWEEP_GAS_HEADROOM_WEI = 500_000_000_000_000n   // 0.0005 ETH kept back for gas (§4.4)
export function buildSweepCalls(items: readonly SweepBasketItem[], mintTo: Address, comment = DEFAULT_COLLECT_COMMENT): SweepCall[]
export function sweepBundle(calls)          // buildMulticall3Batch(calls): allowFailure=false on every call, value = Σ
export function sweepSimulationArgs(calls)  // the SAME calls with allowFailure=true — for eth_call only (§4.3)
export function trimToBudget<T extends { outlayWei: bigint }>(items: readonly T[], budgetWei: bigint): { kept: T[]; dropped: T[] }
export function applySimulation<T>(items: readonly T[], ok: readonly boolean[]): { kept: T[]; dropped: T[] }
export function countSweepMints(logs, items: readonly SweepBasketItem[], account: Address): number  // the receipt-side success test (§5.1)
```

Every call comes from `buildEthMintCall` (Kismet referral, FPSS address,
`minterArguments` encoding) — the treasury-critical rule in `lib/zoraMint.ts`
applies unchanged, and the verifier decodes every sub-call to assert it. The
price and fee on each `SweepBasketItem` are the click-time values (§4.1),
never the index's. `comment` = `DEFAULT_COLLECT_COMMENT`.

### 4.3 Simulation before the prompt

```ts
// lib/sweepSimulate.ts
export async function simulateSweep(
  client: PublicClient, account: Address, calls: readonly SweepCall[],
): Promise<{ ok: boolean[] } | { error: 'insufficient-funds' | 'rpc' }>
export async function estimateSweepGasCost(client, account, calls): Promise<bigint | null>   // §4.4
```

`simulateContract` on Multicall3 `aggregate3Value` with the bundle from
`sweepSimulationArgs` — **`allowFailure: true` on every sub-call**, `value = Σ
value`, `account`. This is an `eth_call`: nothing is sent and nothing can
strand. The decoded `Result[].success` flags map 1:1 to items through
`applySimulation` (`lib/sweepBatch.ts`, pure; a length mismatch drops
everything, fail-closed). What the user signs is rebuilt from `kept` through
`sweepBundle` (`allowFailure: false`) — the verifier asserts the strict bundle
never carries `allowFailure: true` (the stranding hazard: a failed
value-carrying sub-call leaves its ETH in Multicall3, which has no withdraw and
no `receive` — §0 and the record in §9).

Two caveats the implementation respects: (a) op-geth's `eth_call` enforces
`balance ≥ value` when `from` is set, so the balance trim (§4.4) runs
**before** simulating, and an `insufficient funds` revert is treated as that
state (the priciest row is shed and the bundle re-simulated) rather than as a
per-item failure; (b) at most `MAX_SIMULATIONS` = 3 simulations per open
(initial + 2 refills, `lib/sweepVerify.ts`): a refill that would go
unsimulated is not made, and rows still unresolved when the cap is hit never
reach the wallet.

### 4.4 Balance trim and gas

Two steps, both in `verifyBasket` (`lib/sweepVerify.ts`):

1. **Before simulation**: `budgetWei = ethBalance − SWEEP_GAS_HEADROOM_WEI`
   (0.0005 ETH, a constant that covers a 20-mint Multicall3 bundle on Base with
   a wide margin), then `trimToBudget` keeps the longest cheapest-first prefix
   with `Σ outlay ≤ budgetWei`. Cheapest-first makes the trim a prefix, so the
   user always keeps the best-value part of the basket; the rest is shown as
   `needs more ETH`.
2. **After the final simulation**: `estimateSweepGasCost` on the exact strict
   bundle — `estimateContractGas × maxFeePerGas` (one `eth_estimateGas` plus
   `estimateFeesPerGas`, both cheap on Base). Rows are shed from the tail while
   `ethBalance < Σ outlay + gasCost`; one estimate upper-bounds every shorter
   prefix, so shedding never needs a second one. A bundle that cannot be
   estimated (an RPC failure, or one that would revert) is never presented as
   ready: the sheet reads `Could not verify the sweep on-chain — try again`
   and retry re-verifies from the top. There is no constant fallback.

`verifyBasket(client, account, pending, n)` returns `{ ok: true, rows,
gasCostWei }`, or `{ ok: false, reason: 'rpc' }` when any read failed. Every
`basket` row it returns passed the last simulation it was part of, and the
basket's outlay plus gas fits the balance read in the same aggregate. Row
states (`SweepRowState`): `pending` (not yet verified) · `basket` (in the
bundle) · `reserve` (verified, beyond `n`, hidden; refills a dropped row) ·
`dropped` (with its reason) · `unaffordable` (`needs more ETH`) · `removed`
(by the user) · `swept` (minted in the last confirm).

---

## 5. Client

### 5.1 `hooks/useSweep.ts`

State machine (`useWalletRecovery('sweep', 'Sweep')`, `useEnsureBase`,
`useEnsureConnected`; an `inFlightRef` latch against a double tap, an
`openSeqRef` so a verification that finishes after a newer `open()` discards
its result, a `verifiedForRef` holding the signer the rows were verified for,
and a `pendingHashRef` for a sweep sent but never seen mined):

```
idle ─open→ loading ─→ verifying ─→ ready ─confirm→ minting ─→ confirming ─→ recording ─→ done
                          └→ empty                    └→ error (the sheet re-opens to re-verify)
```

1. `open(n)` (the button fired `sweep_open` once, before mounting the sheet):
   ensure connected (a declined connect → `idle`); if a previous sweep's
   receipt wait timed out, read that hash once — still pending → `error`
   (`Your last sweep is still pending — check your wallet before trying
   again`), mined → continue; fetch `/api/sweep?n=n` (`empty` when disabled or
   no pool); render the rows at once as `pending` (state `verifying`).
2. Verification is `verifyBasket` (§4.1–4.4) against the Base public client —
   read-only, so the wallet is not asked to switch chains here. `ok: false` →
   `error` (`Could not verify the sweep on-chain — try again`); otherwise
   `ready` when any row is in the basket, else `empty`.
3. `confirm()`: refuse while in flight or with an empty basket; the signer is
   read from wagmi at the tap and must be the one the rows were verified for,
   else `Wallet changed — re-verifying` and `open(n)` runs again instead of a
   send; `trackFunnel('sweep_attempt')`; `ensureBase()` then a chain guard
   (`getAccount(config).chainId === base.id`, as `useCollectAll`); N ≥ 2 →
   `writeContractAsync` Multicall3 `aggregate3Value` with `sweepBundle` (strict)
   and `dataSuffix: BUILDER_DATA_SUFFIX`; N = 1 → the direct `1155.mint` from
   `buildEthMintCall` with the same suffix. The hash is held in
   `pendingHashRef` until `waitForTransactionReceipt({ timeout: 300_000 })`
   returns. `status !== 'success'` → `Sweep reverted on-chain — nothing was
   charged`. Then the receipt must SHOW the mints: `countSweepMints` counts one
   `TransferSingle(0x0 → user, id)` per basket row from the row's own
   collection; anything short (a wallet-side cancel that replaced the
   transaction) → `The transaction was replaced in the wallet — check it before
   trying again`. Everything downstream uses `receipt.transactionHash` (a
   speed-up mines under a new hash).
4. Records: one `POST /api/collect` per basket row with the mined hash,
   `currency: 'eth'`, `pricePerToken` (the bare live price, as collect-all
   sends), `RECORD_ATTEMPTS` = 5 spaced attempts (≈ 6 s in all, `keepalive:
   true` — the server 403s until its own RPC sees the receipt), then
   `reportClientError('sweep.record_failed', …)` for a row that never records.
   The 60/min per-IP budget on `/api/collect` was sized for a 20-batch.
5. `done`: rows marked `swept`, `result = { hash, minted }`, toast `Swept N
   artworks!`, `trackFunnel('sweep_success')`. There is no separate "next":
   the sheet's primary button calls `open(n)` again from every settled state
   (`done`, `error`, `empty`), and the next verification excludes what the
   wallet now owns.

Return shape:

```ts
export interface UseSweepReturn {
  status: SweepStatus       // 'idle' | 'loading' | 'verifying' | 'ready' | 'empty' | 'minting' | 'confirming' | 'recording' | 'done' | 'error'
  rows: SweepRow[]          // lib/sweepVerify: { key, item, state, reason?, priceWei, feeWei, outlayWei }
  n: number                 // basket size the sheet asked for
  totalWei: bigint          // Σ outlay of the basket rows — the exact value that will be sent
  unaffordable: number      // rows the wallet cannot cover
  result: { hash: Hash; minted: number } | null
  open(n?: number): Promise<void>
  remove(key: string): void   // basket → removed. No re-simulation: the remaining sub-calls
  restore(key: string): void  // are independent of the removed one and the total only shrinks
  confirm(): Promise<{ hash: Hash; minted: number } | null>
}
```

`sweep_open` / `sweep_attempt` / `sweep_success` are in `FUNNEL_EVENTS`
(`lib/funnel.ts`) and documented in `ANALYTICS.md`.

### 5.2 `components/SweepSheet.tsx` and `components/SweepButton.tsx`

- Sheet: the `PatronInfoModal` skeleton (fixed inset, `bg-black/80`, centered
  `max-w-md` card, `border-line`, mono uppercase header; `useBodyScrollLock`,
  `useEscapeKey`, `useFocusTrap`, backdrop click closes), rows in a
  `flex-col gap-2` list that scrolls inside the card (`max-h-[50vh]`) so the
  totals and the primary button stay in view; thumbnails 40 px via
  `MomentImage` (`src` = raw `image` URI, thumbhash placeholder); artist from
  the enriched creator (username, else the short address); price in
  `formatPrice(priceWei, 'eth')` with the fee as a muted `+ fee` suffix; `×`
  per row (44 px hit area) and `undo` on a removed row, both inert while busy
  and after a sweep landed. The artwork name truncates to one line; the
  right-hand column is capped at half the row so a long reason wraps instead
  of squeezing the name away. Totals use `formatPrice` on the summed outlay
  (✏️ no `formatEthChip` move needed) and `useEthUsd` for the `≈ $` label
  (omitted when the rate is unavailable); `aria-live="polite"` on the totals
  so screen readers hear the count change after verification.
- Button label follows `status` exactly as `CollectAllAction.statusLabel`
  does (§1.2 item 4); the primary is disabled while busy and, in `ready`, when
  the basket is empty; the size toggle is disabled while busy. The sheet's
  first paint (it arrives through a lazy chunk) reads as `loading…`, never as
  a one-frame `connect wallet`.
- Button: `components/SweepButton.tsx`, mounted once in
  `DiscoverMarketView`'s `stickyHeader` top row (§1.1); hidden until
  `/api/sweep` says `enabled` with a non-empty pool (`useSweepAvailable`, one
  shared react-query with a 60 s stale time; the header reads the same hook to
  keep its two-child layout while the button is absent).

---

## 6. Recording, feeds, and notifications

Unchanged from collect-all: `/api/collect` verifies each `TransferSingle(0x0 →
account, id)` from the right collection in the one receipt (the Multicall3
receipt carries N such logs from N contracts), applies the per-tuple
idempotency gate, bumps the trending zsets, appends the collected list, and
notifies each creator with a server-derived price. Two consequences to state
rather than change:

- **Trending impact.** A sweep records N collects at once, so cheap pieces
  will climb "most sales" / "latest sales" faster than before. They are real
  sales; accept it, and revisit if sweeps dominate the tabs.
- **`Purchased.sender` = Multicall3** on the batched path (cosmetic; the feeds
  and `/api/collect` join on `TransferSingle.to`, as today's collect-all).

Optional later: `POST /api/collect/batch` so one receipt fetch verifies all
N records instead of N fetches of the same receipt.

---

## 7. Verification, CI, rollout

Four layers, three of them in `npm run check`:

- **`verify:sweep`** (`scripts/verify-sweep.ts`, 162 assertions) — the pure rules
  (window, supply, admission, ranking incl. the artist-interleave and a property
  sweep, pool cut, serve selection, `clampSweepN`, the Moment projection, the
  bundle builders decoded back to `mint(FPSS, id, 1, [KISMET_REFERRAL], (mintTo,
  comment))`, strict vs simulated bundles, the budget trim, the simulation
  mapping) **and the network half on a fake chain behind a real viem client**
  (`scripts/_sweep-fake-chain.ts`, multicall batching on like `lib/wagmi.ts`):
  `fetchEligibleTokensMulti`'s per-row rules and its single-`eth_call` claim,
  `readMintFeesWithBound`'s fail-closed map, `simulateSweep`'s per-slot flags
  and viem's real insufficient-funds mapping, `estimateSweepGasCost`, and
  `verifyBasket` end to end — live values over index values, every drop reason,
  the balance-trim boundary to the wei, simulation drop + refill, the
  simulation cap, insufficient-funds shedding, the gas refinement, an RPC
  failure at each step, a malformed node answer — the receipt-side success
  test (`countSweepMints`, incl. a wallet-side cancel) and the pool staleness rule.
- **`verify:sweep-index`** (`scripts/verify-sweep-index.ts`, 25 assertions) —
  `rebuildSweepIndex` on the real modules against the fake chain over HTTP and
  the mock Upstash: every candidate rule, both chain passes, the chunking (200 /
  100 / one fee read) and the pool cut, the persisted blob's round trip,
  abort-don't-overwrite, corrupt or unreadable blobs, and the flag's `'1'` →
  number-`1` round trip with a Redis failure propagating on a cache miss.
- **`verify:agent:routes`** (section 4c of `scripts/verify-agent-routes.ts`) —
  the REAL built server: `/api/sweep` off (cache header without SWR) → the admin
  front door (401 / 403 / 400 / 200, the audit write) → on with no build → a
  seeded pool with `n` clamping and the serve-time hide filter → a pool older
  than a day serving empty (`stale: true` on the admin read) → off again with
  the memo invalidated by the write.
- **`scripts/e2e/sweep.ts`** (54 assertions; a built app, a server and Chromium,
  so outside `check` — see `scripts/e2e/README.md`) — the button in the
  discover header at 375 px (no overflow, the stats block wraps under) and
  1280 px, the sheet's painted states, the exact transaction the wallet is asked
  to sign (Multicall3, Σ value, every sub-call strict, mintTo = user, the
  ERC-8021 suffix appended), the receipt-driven finish, nine `/api/collect`
  records verified server-side against the same fake chain, the three funnel
  beacons counted once each in Redis, ownership exclusion on the next round,
  "add ETH, then re-check", the hidden button with the flag off (the header's
  two-child layout byte-identical to before), a wallet-side cancel that must
  never read as swept, the direct-mint path for a single item, and two things a
  frame-by-frame walkthrough caught (a dropped row's name stays visible beside a
  long reason; a success toast after an earlier failure carries no stale
  description).

Existing checks cover the rest: `typecheck`, `lint`, `verify:a11y` (the
sheet's text), `check:bundle` (the sheet lazy-loads behind the button).

**Rollout**: ship with `kismetart:sweep-enabled` absent (off); run the cron
once (`/api/cron/sync-stats?secret=…`) to materialize the index; check
`GET /api/admin/sweep` (`index.pool > 0`, `stale: false`) or
`/api/admin/stats-health` (`sweepIndex`, `sweepHealthy`); enable with
`POST /api/admin/sweep {"enabled":true}`; watch
`sweep_open → sweep_attempt → sweep_success` in the funnel. A pool the cron
stops refreshing serves empty after a day (`SWEEP_INDEX_MAX_AGE_MS`), so a dead
cron hides the button rather than serving a dead pool; the health route flags
it at three hours.

---

## 8. What is left to be desired

The question raised with the decision: is a cap or a floor needed? Assessment
for the ETH-only, cheapest-N design, with the reasons:

| Item | Needed for v1? | Assessment |
|---|---|---|
| **Price floor** (min outlay) | **No** | "Excluding free" already floors at 1 wei. A dust-priced piece (say 0.00001 ETH) would rank first, but it still pays the full protocol fee, minting is Pass-gated, the pool is small and curated, and the hide-moment lever removes an abuser in one click. The sheet shows every row before signing, so nobody sweeps blind. Not built; a floor would be a few lines in `rankSweepCandidates` |
| **Per-artist cap** | **No** | Its purpose (variety) is mostly served by the zero-cost tie-break: within a price tier, artists interleave, so a wallet with twenty pieces at one price cannot fill a sweep from that tier. Across tiers a cheaper artist legitimately wins; that is what "cheapest" means. Not built; a cap would be a few lines in `rankSweepCandidates` |
| **Per-item max price** | **No** | Cheapest-first bounds it by construction: the priciest item in a sweep is the N-th cheapest live mint. The sheet shows it |
| **Spend cap** | **No** | The total is displayed to the wei and the wallet balance trims the basket; a separate cap adds a knob without adding protection |
| **Size cap (20)** | **Yes, keep** | Wallet-preview readability, and `/api/collect`'s per-IP budget is sized for it. Larger sweeps are rounds |
| USDC-priced work is invisible to sweep | Accepted by decision | Not announced by the sheet (§1.4). Artists who price in USDC do not appear in this discovery surface; that is a nudge toward ETH pricing, which is worth knowing when explaining the feature to artists |
| New mints lag up to an hour | Acceptable | `append on mint` (§2.5) removes it later for ~30 lines |
| Sold-out rows in the pool between rebuilds | Handled | Click-time verification drops them; the optional pool refresh (§2.5, not built) would make them rare |
| Two collectors sweep the same 1/1 in the same minute | Rare, handled | The later bundle reverts atomically (nothing charged), and the next attempt drops it. A `prefer remaining ≥ 2` tie-break could reduce it; not worth v1 complexity |
| Gas sponsorship | Not applicable | Paymasters ride EIP-5792, which this design deliberately does not use. The user pays cents |
| Non-inprocess Zora collections / legacy `mintWithRewards` | Out of scope | Same limits as collect-all; documented in `lib/zoraMint.ts` |
| Agent exposure | Nice to have | One branch in `/api/sweep` (§3) |
| Random / rotating tie-break for scarce editions | Not needed | Deterministic artist-interleave is enough; revisit only if sweeps visibly chase the same pieces |

The one genuine policy choice that remains is the **tie-break**, and it is
cheap: artists interleave within a price tier, then newest first. Everything
else is either bounded by construction (cheapest-first), shown before signing
(the sheet), or already covered by moderation levers.

---

## 9. Validation record (2026-09-26)

Every claim the design makes was traced to its source. ✅ = verified as
written; ✏️ = corrected (the body above already carries the correction);
⚠️ = not verifiable from this environment, stated with a hedge.

**On-chain and protocol behavior**

| Claim | Verdict | Evidence |
|---|---|---|
| Multicall3 `aggregate3Value` dispatches each sub-call to its own `target` with its own `value`, so a cross-collection ETH batch is one tx | ✅ | `lib/zoraMint.ts` `buildMulticall3Batch`; Multicall3 source (`mds1/multicall`, `src/Multicall3.sol`) |
| `allowFailure=true` on a reverting value-carrying sub-call strands the ETH in Multicall3 | ✅ | Source: the failed `call{value}` leaves `val` in the contract, `msg.value == valAccumulator` still holds, and there is no withdraw/`receive` |
| `eth_call` with `from` + `value` fails when the sender cannot cover the value, so the balance trim must run before simulation | ✅ | go-ethereum `core/state_transition.go`: `buyGas` adds `msg.Value` to the balance check unconditionally; `execute` re-checks `CanTransfer` |
| ERC20Minter pulls USDC from `msg.sender`, ruling out Multicall3 for USDC | ✅ (moot for ETH-only) | `lib/zoraMint.ts` `buildMulticall3Batch` docblock |
| Zora `mintFee()` is read per collection with a 0.01 ETH sanity bound | ✅ | `readMintFeeWithBound`; the bound is now exported |

**Library and toolchain**

| Claim | Verdict | Evidence |
|---|---|---|
| viem `multicall` chunks by calldata bytes with a 1,024-byte default | ✅ | viem 2.55.10 `actions/public/multicall.ts` (`batchSize ?? 1024`) |
| A large `batchSize` makes a 200-read chunk one `eth_call` | ✏️ replaced | The same action turns a *rejected* chunk into per-call failures under `allowFailure: true`; the builder now uses `aggregate3Strict` (throws on RPC failure, skips reverting rows) |
| `simulateContract`, `estimateContractGas`, `estimateFeesPerGas` exist for the client phase | ✅ | `node_modules/viem/_types/actions/public/` |
| Base's viem chain definition carries the Multicall3 address | ✅ | `viem/_esm/chains/definitions/base.js` |
| Verify scripts import production modules with the `@/` alias under bare Node | ✅ | `scripts/ts-alias-hooks.mjs`; `verify:sweep` runs that way |

**Codebase contracts**

| Claim | Verdict | Evidence |
|---|---|---|
| The census walk already resolves creators (KV override), folds smart wallets, and applies the three hide sets | ✅ | `lib/catalogCensus.ts`; refactored into `resolveCatalog` + `censusFromCatalog` with the counts unchanged (same set-cardinalities, computed per item) |
| `recordStatsRun` / `StatsPhase` extend cleanly | ✅ | `lib/statsHealth.ts`; `getStatsHealth` now reads three phases |
| `/api/admin/stats-health` is a dashboard panel | ✏️ | It is a JSON ops endpoint (`app/api/admin/stats-health/route.ts`); it now reports `sweepIndex` + `sweepHealthy` without touching `healthy` |
| `/api/collect` allows 60/min per IP, sized for a 20-batch, and verifies each `TransferSingle` against the named collection | ✅ | `app/api/collect/route.ts` (`checkRateLimit('collect:…', 60, 60)`, `verifyMintOnChain` requires `log.address === collection`) — a multi-collection receipt verifies per item |
| Adding funnel events needs a server allowlist change too | ✅ (no extra work) | `app/api/funnel/route.ts` builds its allowlist from `FUNNEL_EVENTS`, so extending the array updates both |
| `FilterPill` can be reused by the pill | ✏️ moot | The pill was withdrawn with the one-button decision (§1.1); `SweepButton` carries its own classes |
| `formatEthChip` is reusable | ✏️ moot | Module-local to `components/CollectAllAction.tsx`; the sheet formats through `formatPrice` instead, nothing moved |
| `enrichMomentsWithKismetMeta` supplies the creator username from a `Moment[]` | ✅ | `lib/momentEnrichment.ts`; the sheet reads nothing else from the overlay, so the response carries nothing else |
| Flag as `kismetart:flags:sweep`, plain `'1'/'0'` | ✏️ | Renamed `kismetart:sweep-enabled` to match the existing flags, read via `isFlagSet` (Upstash returns the number `1` for a stored `'1'`) |
| `MAX_REASONABLE_MINT_FEE_WEI` is importable | ✏️ | It was module-private; exported now |
| `MomentMeta.createdAt` is the pinned first-seen instant | ✅ | `lib/notifications.ts` |
| Patron collection constant is lowercase and excluded by the census | ✅ | `lib/patronCollection.ts`, `lib/catalogCensus.ts` |
| `getHiddenMomentsSet` and siblings throw on a Redis failure (strictRead) | ✅ | `lib/hiddenMoments.ts`; `/api/sweep` therefore fails closed with a 503 |

**Not verifiable here**

| Claim | Status |
|---|---|
| Farcaster Mini App host wallet executes `wallet_sendCalls` atomically | ⚠️ Moot for ETH-only: the sweep is a plain `eth_sendTransaction` to Multicall3 |
| Live catalog size today | ⚠️ The July snapshot (42 artworks / 30 collections) is the latest number in the repo; the builder is sized for thousands |
| Per-mint gas on Base | ⚠️ The repo's ≈ 250k estimate is used; the cap exists for preview readability, not cost |

---
