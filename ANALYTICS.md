# Platform Analytics — what `/api/stats/platform` captures

A complete field-by-field description of the platform analytics endpoint
(`app/api/stats/platform/route.ts`): where every number comes from, how it is
computed, how fresh it is, what qualifies it, and what is deliberately *not*
captured.

Companion docs: `REDIS_IMPLEMENTATION_REVIEW.md` (key inventory),
`OPS_RUNBOOK.md` (cron operations).

---

## 1. What the endpoint is

`GET /api/stats/platform` is the platform-wide aggregate companion to the
per-artist `/api/stats` read. It serves **four public blocks** — `catalog`,
`sales`, `passes`, `earnings` — plus a **fifth, admin-only block** (`funnel`)
that only appears for an authenticated admin requesting `?funnel=1`.

Key properties:

| Property | Value |
| --- | --- |
| Visibility | Public by design — aggregates derivable from the public In•Process feed + the chain; exposes no individual's figures (per-artist earnings stay private-by-default on `/api/stats`) |
| Rate limit | 60 requests / 60 s per IP → `429` |
| Cache | Public payload: `public, s-maxage=300, stale-while-revalidate=600`; admin funnel variant: `private, no-store`; both send `Vary: Cookie` |
| Freshness | Snapshots rebuilt **hourly** by the `sync-stats` cron (`vercel.json`: `0 * * * *` → `/api/cron/sync-stats`, `CRON_SECRET`-protected); the edge cache only smooths bursts |
| Nullability | Each block is `null` until its first successful computation — never fabricated zeros |
| Chain scope | Base (chain id 8453) only |
| Consumers | No in-repo UI consumes it; it is an operator/API surface |

### Data flow

```
In•Process /transfers (type=payment, network-wide)   In•Process /timeline (per tracked collection)
        │                                                     │
        ▼  hourly full scan (rebuildStats)                    ▼  hourly census (rebuildCatalogCensus)
  scope gate: tracked registry ──► per-artist zsets      dedup + KV creator override + hidden sets
        │                          + platform snapshot        │
        ▼                                                     ▼
  kismetart:stats:platform:sales                 kismetart:stats:platform:catalog
        │                                                     │
        └──────────────┬──────────────────────────────────────┘
                       ▼
            GET /api/stats/platform  ◄── kismetart:stats:royalty:{eth,usdc} (event-driven credits)
                       ▲                 ◄── Chainlink ETH/USD (read-time, 60 s cache)
                       └── admin + ?funnel=1 ◄── kismetart:funnel:<event>:<day> counters
```

The sales snapshot and the per-artist earnings zsets are written by the **same
scan with the same row-gating rules** (`lib/statsMath.ts accumulateTransfer`),
so the platform totals and artist cards can never disagree about what counted
as a sale.

---

## 2. `catalog` — creation-side census

**What it answers:** how much work exists on the platform, regardless of
whether it ever sold. The sales feed only sees *paid* activity; the census is
the only counter that includes free mints, unsold work, and artists who
haven't sold yet.

**Source:** hourly walk of every Kismet-tracked collection's In•Process
`/timeline` (200 moments/page, ≤20 pages ⇒ 4,000-moment cap per collection,
concurrency 6), merged with synthesized cover-mints the upstream indexer
misses (`lib/coverMomentSynthesis.ts`). The Patron/Mint-Pass collection is
excluded — passes are not artworks. Implementation: `lib/catalogCensus.ts`.

| Field | Meaning |
| --- | --- |
| `artworksMinted` | Distinct artworks (`collection:tokenId` pairs) across tracked contracts, **including hidden** work. Deduped within and across collections. |
| `hiddenArtworks` | Artworks suppressed from public feeds by any of the timeline's exact three filters: moment-hidden, hidden collection, or admin-hidden creator. `null` on a pre-field snapshot during a deploy window. |
| `visibleArtworks` | `artworksMinted − hiddenArtworks` — the public-facing count (computed in the route). |
| `artistsMinted` | Distinct creators of those artworks, **including** makers whose only work is hidden. Attribution uses the shared precedence (`resolveMomentCreator`): KV minter-EOA override → feed creator; smart-wallet→EOA folded so a relayed mint and its owner count once. |
| `visibleArtists` | Creators with ≥1 non-hidden artwork — the public roster. `artistsMinted − visibleArtists` = makers whose every piece is hidden. |
| `collections` | Tracked contracts scanned (case-deduped, patron excluded). |
| `coverage.possiblyTruncated` | Collections whose walk hit the 20-page cap or lost a later page — their counts are lower bounds. |
| `coverage.pageFailures` | Later-page reads that failed (a **page-1** failure aborts the whole census instead — see guards). |
| `coverage.unattributed` | Artworks with no resolvable creator — counted in `artworksMinted`, absent from `artistsMinted`. |
| `updatedAt` | Epoch ms the census snapshot was written. |

**Integrity guards:** single-flight lock (600 s TTL); any unreadable
collection aborts the run (previous snapshot stays live); a >20% shrink in
artworks *or* collections vs. the last successful run refuses to overwrite
(the catalog is monotonic in normal operation, so a big shrink means a
degraded read, not reality).

---

## 3. `sales` — paid primary-market activity on Kismet collections

**What it answers:** how many editions have been bought, by how many people,
from how many artists — paid activity only.

**Source:** hourly full scan of the In•Process `/transfers` feed
(`type=payment`, i.e. paid rows only; 100 rows/page; abort past 1,000 pages).
The feed is **network-wide** (every In•Process client app), so every row is
scope-gated against Kismet's tracked-collection registry; only in-scope rows
fold into these figures. Implementation: `lib/stats.ts runRebuild` +
`lib/statsMath.ts accumulateTransfer`.

Row gates, in order: corrupt values (NaN/∞/>1e9) dropped → zero/free rows
dropped (free mints never count as sales) → deduped by a stable feed
identifier (`id` / `transfer_id` / `tx_hash+log_index`) → scope-classified:

- `in` — collection in the tracked registry → folds here
- `pass` — the Patron collection → folds into `passes` instead
- `out` — resolvable but untracked → excluded, counted in `coverage.outOfScope`
- `unknown` — no collection ref on the row → excluded **fail-closed**, counted
  in `coverage.scopeUnknown` (a money figure never includes a row we can't place)

| Field | Meaning |
| --- | --- |
| `editionsSold` | Σ quantity over in-scope paid transfers (absent/invalid quantity → 1; capped at 1e6/row). Includes editions whose creator couldn't be resolved — the sale still happened. |
| `transactions` | In-scope paid transfers folded (post-dedup). |
| `collectors` | Unique **buyer wallets**. Buyer extraction is strict: several plausible field spellings tried in preference order, validated as a real 40-hex address (usernames/ENS/zero-address rejected); ERC-1155 `from` is deliberately never used (on a primary mint it's the zero address or a relayer). Smart wallets folded onto their owner EOA so one person isn't counted twice. |
| `artistsWithSales` | Unique credited creators on in-scope rows (post smart-wallet fold). Attribution precedence: KV minter-EOA override → feed per-moment creator → collection-level creator → dominant fee recipient. |
| `coverage.buyerMissing` | In-scope rows with no recognizable buyer field — the direct read on how much `collectors` undercounts. |
| `coverage.unknownCurrency` | In-scope rows whose **value** was skipped because the currency wasn't ETH or Base USDC (pricing a foreign token as ETH would fabricate earnings). The sale still counts in `transactions`/`editionsSold`. |
| `coverage.droppedMints` | In-scope editions with no resolvable creator — inside `editionsSold`, absent from any artist's credit. |
| `coverage.outOfScope` | Paid rows on *other In•Process apps'* collections, excluded from all totals. Large values are normal — it measures the rest of the network, not a defect. |
| `coverage.scopeUnknown` | Paid rows with no resolvable collection, excluded fail-closed. Non-zero values mean real sales might be missing from the totals. |
| `updatedAt` | Epoch ms the snapshot was written. |

**Invariant:** `transactions + passes.transactions + coverage.outOfScope +
coverage.scopeUnknown` = total paid transfers counted network-wide that scan.

**Integrity guards:** single-flight lock (900 s); abort — leaving the previous
snapshot live — on any fetch failure, wrong-shaped 200, feed exceeding the
scan window, non-row-unique dedup identifiers (duplicates > kept), a zero-row
scan over live data, a >20% shrink in network-wide counted rows, or a >20%
shrink in in-scope transactions (scope-collapse detector). The snapshot is
persisted only after the per-artist write commits, so it can never reflect a
scan the guards rejected.

---

## 4. `passes` — Patron/Mint-Pass activity

**What it answers:** pass commerce, deliberately split out of the art figures
(a pass is platform revenue, not an artwork sale).

| Field | Meaning |
| --- | --- |
| `sold` | Paid pass **editions** (Σ quantity on `pass`-scoped rows from the same transfers scan, same gates). |
| `transactions` | Paid pass purchase transfers. |
| `invited` | Editions airdropped as invites — from **Kismet's own airdrop records** (`lib/airdrops.ts`), because Kismet airdrops bypass the In•Process relay and the transfers feed never sees them. Best-effort: an upstream/Redis failure reads 0 for one run and the next hourly scan heals it. |
| `eth` / `usdc` | Gross paid pass volume by currency (human units). |
| `usd` | Read-time valuation at the current Chainlink price (same honesty rule as `earnings` — see below). |

On artist cards (not this endpoint), a pass sale's count/earnings are credited
to the real artist(s) in the payout split — platform treasury/referral/
residencies/operator wallets are excluded — so the treasury never appears as
an "artist". Pass revenue is **not** inside `earnings.primary`.

---

## 5. `earnings` — gross value captured

**What it answers:** money that moved through the platform's tracked
primary market, plus creator royalties on Kismet-listed resales.

| Field | Meaning |
| --- | --- |
| `primary` | **Gross buyer payments** on primary art mints of tracked collections (what buyers paid, before artist splits and the platform cut). Passes excluded. Same snapshot as `sales`. |
| `secondary` | Creator royalties on resales **filled through Kismet's own listings** — credited event-per-fill from the on-chain-verified listings PATCH handler (`creditListingRoyalty`), idempotent per listing (atomic claim + credit + per-fill ledger in `kismetart:stats:royalty-ledger`). When the EIP-2981 receiver is the moment's 0xSplits contract, the amount is decomposed pro-rata to the real member wallets. |
| `total` | `primary + secondary`, element-wise. |
| `ethUsd` | The Chainlink ETH/USD price (Base feed `0x7104…Bb70`, 60 s cache, 2.5 s timeout) used to derive the `usd` fields; `null` when unavailable. |

Each of `primary`/`secondary`/`total` carries `{ eth, usdc, usd }`:

- `eth` / `usdc` are the **stable truth**, accumulated in native units.
- `usd` is **derived at read time at the current price** — it is a present-day
  valuation of lifetime totals, *not* the USD value at each sale's moment, so
  it moves with the ETH price between reads.
- Honesty rule: when the price is unavailable and a figure has an ETH leg,
  `usd` is `0` — never a silently-USDC-only number that would read as a crash
  in earnings. A figure with no ETH leg needs no price and stays exact.

Recognized currencies are exactly **native ETH** (null/empty/zero-address
currency field) and **USDC on Base** (`0x8335…2913`). Anything else skips the
value bucket and surfaces in `sales.coverage.unknownCurrency`.

---

## 6. `funnel` — conversion counters (admin-only, `?funnel=1`)

Absent from the public payload. Appears only when the requester holds a valid
admin session *and* passes `?funnel=1`; a non-admin `?funnel=1` response stays
byte-identical to the public payload (no oracle), and cache isolation is
guaranteed by `private, no-store` on the admin variant plus `Vary: Cookie`.

This is the platform's **only behavioral analytics**. There is deliberately no
third-party analytics service; the funnel is "the smallest honest instrument":
seven named events, counts only — **no identifiers, no session IDs, no paths,
no user agents, nothing per-user**.

The seven events, in funnel order, and where they fire:

| Event | Fired from | When |
| --- | --- | --- |
| `landing` | `DiscoverPage` | Feed viewed — once per browser session (sessionStorage de-dupe; back-nav isn't a new visit) |
| `connect_modal` | `useEnsureConnected` | Wallet-connect modal shown |
| `connect_success` | `FunnelConnectTracker` | Fresh wallet connection (auto-reconnects excluded) |
| `collect_attempt` | `useDirectCollect` | Collect flow initiated |
| `collect_success` | `useDirectCollect` | Collect confirmed |
| `mint_attempt` | `MintForm` | Mint submitted |
| `mint_success` | `MintForm` (both paths) | Mint confirmed |

Pipeline: `trackFunnel()` sends a fire-and-forget beacon
(`navigator.sendBeacon`, keepalive-fetch fallback) → `POST /api/funnel`
(allowlisted event names, ≤256-byte body, 60/min/IP rate limit, always `204`)
→ `INCR kismetart:funnel:<event>:<YYYY-MM-DD>` (UTC day buckets, **90-day
TTL**).

Response shape (`lib/funnelServer.ts getFunnelCounts`, default window 14
days): `{ since, days, totals: {event: n}, byDay: [{date, ...events}] }` —
zero days included so a gap reads as "no traffic", not missing data. Returns
`null` on a Redis failure so the block is omitted rather than serving zeros.

---

## 7. Reading the 2026-07-16 snapshot

The live payload captured on 2026-07-16 (both `updatedAt` stamps fall on the
same cron run, ~1 s apart — rebuild, then census — so the pipeline is
healthy):

**Catalog** — 42 artworks by 18 artists across 30 tracked collections. 12
artworks (29%) are hidden, leaving 30 public; 2 of the 18 artists have *only*
hidden work (18 − 16 visible). All coverage counters are 0: no truncated
walks, no failed pages, every artwork attributed.

**Sales** — 210 editions across 210 transactions: every purchase was a
single-edition buy. 68 unique collectors (~3.1 editions each); 16 of the 18
minted artists (89%) have at least one paid sale. Coverage is clean where it
matters: every buyer identified, every currency recognized, every sold edition
attributed to a creator. `outOfScope: 613` means the scan classified 834 paid
transfers network-wide (210 art + 11 passes + 613 other apps + 0 unplaceable)
— i.e. ~73% of the In•Process feed is other apps' volume, correctly excluded.
`scopeUnknown: 0` means nothing was dropped blind.

**Passes** — 11 passes sold for 0.484 ETH (uniform 0.044 ETH each) ≈ $903 at
the read-time price; 2 editions invited via airdrop. Note pass revenue
($903) currently exceeds art primary volume ($830).

**Earnings** — lifetime gross: 0.4235 ETH + 40 USDC primary (≈ $830.13),
0.0008 ETH Kismet-listing royalties (≈ $1.49), total ≈ $831.62, all valued at
the Chainlink price of $1,865.72 captured in `ethUsd`. The USDC leg shows at
least one sale was paid in USDC.

---

## 7b. The artist profile card — datapoint provenance

The owner-facing stats card (`components/ProfileStats.tsx`, fed by
`/api/stats?artist=…`) shows three figures with **two different sources**:

| Card figure | Source | Why this source |
| --- | --- | --- |
| Earned total (e.g. `$178.24`) | `getArtistEarnings` (`lib/stats.ts`): per-artist Redis zsets rebuilt hourly from the In•Process `/transfers` feed, **Kismet-scoped** (`in` + `pass` rows only, per the 2026-07-14 decision in `lib/statsMath.ts`), summed across the artist's earnings-wallet union (FC siblings + inprocess smart wallets), primary + Kismet-listing royalties, USD at the read-time Chainlink price | The feed is the canonical, complete, rebuildable history of paid sales |
| `N sales` | The mints zset from the same rebuild — Σ edition quantity of paid Kismet sales credited to the artist (split moments credit the artist's own allocation share for value, full quantity for count) | Same scan, same gates as the money figure |
| `$X to distribute →` | `getArtistPending` (`lib/pending.ts`): **live on-chain balances** of the 0xSplits contracts the artist is a payee on (membership from Kismet's mint-time split records, reverse-indexed in `kismetart:splits:by-recipient:*`), × the artist's stored percent, cached 60 s | No feed exposes undistributed split balances, and distribution is permissionless (can happen outside our `/api/distribute`), so any stored ledger would drift — the chain is the only truth |

Split-moment attribution is exact: an artist credited `pct × sale value` in
the stats matches what the split later distributes to them (verified against a
live case: a 0.0014 ETH mint with a 95% allocation both credits and pays
0.00133 ETH).

### Fixed 2026-07-17: pending over-counted shared split contracts

The pending roll-up used to sum the artist's share **per moment** (`SplitJob`),
but several moments can resolve to the **same split contract**
(`getCreatorRewardRecipient` is per token, and 0xSplits deploys deterministic
addresses — the same recipient set + percentages yields the same contract, so
every piece a collab mints with one split config shares one pot). The same
live balance was then counted once per moment: an artist on N moments sharing
one split saw **N× their real pending**. Confirmed in production 2026-07-16/17
with `scripts/check-split-index.mjs`: five moments across two collections all
resolved to one split (pct 95), so a card showed $12.49 "to distribute" where
the real undistributed share was $2.50. `distribute-all` had the same blind
spot — one `/distribute` per moment-job — wasting per-user quota, relay
capacity, and `DISTRIBUTE_ALL_CAP` slots on duplicates (payouts themselves
were always correct: the first call drains the split; 0xSplits can only ever
pay the fixed recipients).

**Fix:** `resolveArtistSplitJobs` (`lib/pending.ts`) now collapses the job
list onto unique split contracts before the balance read
(`dedupeBySplitAddress` in `lib/distributePlan.ts`, covered by
`scripts/verify-distribute.ts`), fixing both the card figure and the
distribute fan-out; `ArtistPending.count` now means distinct funded pots.

## 8. What is deliberately NOT captured

Blind spots to keep in mind when reading the numbers:

- **No web analytics.** No pageviews, sessions, referrers, devices, geo, or
  per-user tracking of any kind — the seven anonymous funnel counters are the
  entire behavioral surface (a deliberate no-third-party-analytics stance,
  same posture as `lib/clientError.ts`).
- **Off-platform secondary market.** Resales on OpenSea/Blur/Zora pay the
  artist's EIP-2981 royalty on-chain but are structurally invisible —
  `earnings.secondary` means *Kismet-listing* royalties, not lifetime
  secondary income. Capturing external fills would need an on-chain indexer.
- **Secondary sale volume.** Only the royalty amounts credited are known, not
  resale prices.
- **Free art mints/airdrops** never appear in `sales` (paid rows only); they
  are visible only through the catalog census. The one airdrop class that *is*
  counted is pass invites, via Kismet's own records.
- **Historical USD.** All `usd` fields are read-time valuations at the current
  ETH price; sale-time USD is not recorded.
- **No public time series.** The public payload is lifetime totals refreshed
  hourly; only the admin funnel has a daily series (14-day window, 90-day
  retention).
- **Wallets ≠ people.** `collectors` counts wallets (smart-wallet→EOA folding
  removes one double-count class, but one human with several EOAs counts
  several times).
- **Currencies beyond ETH/USDC** are counted as sales but their value is
  dropped (surfaced in `unknownCurrency`).
- **Census depth cap:** 4,000 moments per collection; a collection at the cap
  is flagged in `possiblyTruncated` rather than silently under-counted.

---

## 9. Storage inventory

| Redis key | Contents | Write cadence |
| --- | --- | --- |
| `kismetart:stats:platform:sales` | Sales + passes snapshot (JSON) | Hourly absolute overwrite, post-guards |
| `kismetart:stats:platform:catalog` | Catalog census (JSON) | Hourly absolute overwrite, post-guards |
| `kismetart:stats:{mints,earned:eth,earned:usdc}` | Per-artist primary zsets (feed the artist cards; same scan) | Hourly staged rebuild + atomic RENAME swap |
| `kismetart:stats:royalty:{eth,usdc}` | Per-artist royalty zsets (Σ = `earnings.secondary`) | Event-driven, per listing fill |
| `kismetart:stats:royalty-ledger` | Per-fill royalty journal (HSET by listingId) | Event-driven, atomic with the credit |
| `kismetart:royalty-credited:<listingId>` | Idempotency claims | Once per fill |
| `kismetart:stats:last-rebuild` | Shrink-guard baseline (counted + in-scope) | After each successful rebuild |
| `kismetart:stats:{rebuild,census}-lock` | Single-flight locks | 900 s / 600 s TTL |
| `kismetart:funnel:<event>:<YYYY-MM-DD>` | Funnel day counters | Per beacon; 90-day TTL |
| `kismetart:ethusd` | Chainlink price cache | 60 s TTL |

## 10. Source map

| Concern | File |
| --- | --- |
| Endpoint (shape, gating, caching) | `app/api/stats/platform/route.ts` |
| Sales rebuild, snapshot, royalty credit | `lib/stats.ts` |
| Pure per-row accumulation + attribution rules | `lib/statsMath.ts` (unit-verified by `scripts/verify-stats.ts`) |
| Catalog census | `lib/catalogCensus.ts` |
| Transfers feed reader | `lib/inprocessTransfers.ts` |
| Funnel events + client tracker | `lib/funnel.ts` |
| Funnel sink / admin read | `app/api/funnel/route.ts` / `lib/funnelServer.ts` |
| ETH/USD price | `lib/ethPrice.ts` |
| Hourly cron driver | `app/api/cron/sync-stats/route.ts` (+ `vercel.json`) |
