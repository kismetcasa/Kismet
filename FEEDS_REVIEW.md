# Feeds — architecture review

**Date:** 2026-08-29 · **Scope:** every surface that renders a list of moments,
collections or listings, and every route/lib it reads. Line-by-line read of
`app/api/timeline`, `app/api/collections`, `app/api/listings`,
`app/api/featured/*`, `app/api/moments`, `components/{DiscoverPage,
DiscoverMarketView,FeaturedFeed,PaginatedGrid,MomentCard,MarketOvals,
CollectionRow,LazyMount,MarketView,NotificationFeed}`, `lib/{feedAdmission,
paginatedGridQuery,discoverState,listings,saleEnds,collected,kv,redis,
momentEnrichment,showcaseOrder,coverMomentSynthesis,addressUnion,
media/feedPlayback,media/resolveMomentMedia}`, `hooks/{useMomentSale,
useInViewDwell,useViewMode,useWatchlist}`, plus the CI/diagnostic scripts.

Companion docs: `SCALING.md` §2/§B1 (the fan-out cliff — still the correct
top-priority architectural item), `scripts/diagnose-feed-visibility.mjs`
(the G1–G6 visibility gates).

---

## 1. Feed inventory

| Surface | Component | API | Cacheable |
|---|---|---|---|
| Home → **featured** | `FeaturedFeed` | `/api/timeline?featured=1` + `/api/featured/collections-hydrated` | edge 30s / ISR 30s |
| Home → **trending** | `TrendingFeed` → `MomentFeed` | `/api/timeline?sort={latest-sales\|trending\|ending-soon}&scope=standalone` | edge 30s |
| Home → **home (mints)** | `MainFeed` → `MomentFeed` | `/api/timeline?scope=standalone[&following=…]` | edge 30s (no-store with `following=`) |
| Home → **home (collections)** | `CollectionsFeed` | `/api/collections?feed=1` | **none** |
| Home → **artists** | `ArtistsFeed` | `/api/timeline?collection=…` or `?creators=…&sort=trending` | edge 30s |
| `/discover` **primary** | `DiscoverMarketView` | `primaryApiUrl()` → `/api/timeline?scope=…` + browse filters | edge 30s (no-store with `creator=`) |
| `/discover` **secondary** | `DiscoverMarketView` | `secondaryApiUrl()` → `/api/listings?…` | **none** |
| `/discover` **watchlist** | `WatchlistView` | none (localStorage) | n/a |
| `/market` | `MarketView` | `/api/listings` | **none** |
| Profile → mints | `ProfileView` | `/api/timeline?creator=…&limit=50` | no-store |
| Profile → collected | `ProfileView` | `/api/timeline?collector=…&limit=50` | no-store |
| Profile → listings | `ProfileView` | `/api/listings?seller=…` | no-store |
| Collection page | `CollectionView` | `/api/timeline?collection=…&limit=50` | edge 30s |
| Airdrop picker | `MintTabs` | `/api/timeline?airdroppable=…&limit=100` | no-store |
| Notifications | `NotificationFeed` | `/api/notifications` | private no-store |
| Price badges (all cards) | `useMomentSale` | `/api/moments?ids=…` (batched) | edge 30s |

Everything except notifications, listings and the collections feed funnels
through one route: **`app/api/timeline/route.ts`** (1,027 lines).

---

## 2. How `/api/timeline` works

Fan-out-on-read. Per request, in order:

1. **Parse + clamp** (`:170-260`) — `page ≤ 100`, `limit ≤ 100` (the clamp is a
   real DoS control: `fetchLimit` is `page × limit` and is sent verbatim to
   *every* collection upstream). Sorts, browse filters, scope, creators roster
   all validated fail-closed.
2. **Pre-reads** (`:273-297`) — collector zset (union across FID siblings),
   featured zset.
3. **Width** (`:299-328`) — `getTrackedCollectionsByScope(scope)`; narrowed to
   just the featured/collected collections when those filters are on, else
   `tracked ∪ collectedCollections`.
4. **Depth budget** (`:336-384`) — `baseSample = page × limit` (floored at 200
   for sorted/featured/roster feeds); `perCollectionCap = MERGE_BUDGET / N`;
   `fetchLimit = min(baseSample, perCollectionCap)`. Hard width truncation past
   `MERGE_BUDGET` collections with an error log.
5. **Fan-out** (`:385-387`) — `mapWithConcurrency(…, 10, fetchCollection)`;
   each leg is `GET inprocess /timeline` with `revalidate:30` + 8s abort, plus
   a cover-mint synthesis pass.
6. **Merge + dedupe** (`:390-397`) — by `moment.id`, else `JSON.stringify`.
7. **KV stitch** (`:414-483`) — one chunked MGET of moment-meta over the *whole*
   merged set; corrects creator attribution (`resolveMomentCreator`), pins
   `created_at` against inprocess's reindex-on-edit bumps, carries
   `kismet_duration_sec`; write-through backfills missing pins via `after()`.
8. **Filters** in this exact order: creators roster → `scope=standalone`
   created-mints membership (+ off-platform admission, `lib/feedAdmission`) →
   `creator=` → `airdroppable=` (with on-chain ADMIN/MINTER confirmation) →
   `collector=`.
9. **Sort** (`:713-828`) — featured (by `featuredAt`), trending / latest-sales
   (zset score, free mints dropped), ending-soon (`SALE_ENDS_KEY` + a bounded
   sold-out multicall), else newest-first.
10. **Hide** (`:843-893`) — hidden moments ∪ hidden collections ∪ hidden users,
    with the "creator sees their own hidden work on their own profile"
    exception; then `normalizeHiddenFlag` **unconditionally** strips any
    upstream `hidden` flag Kismet didn't set.
11. **Browse filters** (`:905-943`) — `free`, `media`, `resale`, `soldout`, all
    fail-closed, all applied *before* pagination so `total_pages` is honest.
12. **Following bubble** (`:946-956`) → **slice** → **enrich** the page only
    (`enrichMomentsWithKismetMeta`: profile + collection-meta MGETs, hidden
    identity scrub) → cache header.

The design is consistent and unusually well-documented. Two structural
properties matter for everything below:

* **Depth is `page × limit` per collection.** Pagination deepens the sample
  rather than walking a cursor: page 2 re-fetches everything at double depth.
* **Personalized feeds are `private, no-store`** — every profile view re-runs
  the whole fan-out.

---

## 3. Client machinery

* **`PaginatedGrid`** — first page through react-query (`staleTime` 30s,
  `gcTime` 5m, key = exact URL incl. limit, so prefetch and grid dedupe);
  subsequent pages in local state. Sync `loadingMoreRef` latch closes the
  double-fire race; the infinite-scroll observer is deliberately rebuilt per
  committed page so the two stall cases (short first page, sub-margin append)
  self-heal. Manual refresh sets `forceFreshRef` → `?fresh=1` → upstream
  revalidate bypass + `cache: no-store`.
* **`feedPageLimit`** — 10 on mobile UA **or any iframe/RN-webview**, 18 on
  standalone desktop; single source shared by grid and prefetch.
* **Tab warm-up** (`DiscoverPage:503-538`) — hover intent on desktop,
  `requestIdleCallback` on mobile, warming exactly the two PaginatedGrid tabs.
* **`MaybeLazy`/`LazyMount`** — mobile only; eager 4, mount at 200px, **unmount
  at 3000px** with a height snapshot so scroll never jumps.
* **Per-card reads are dwell-gated** (`useInViewDwell`, 200px/150ms) and then
  **coalesced** (`useMomentSale` → one `/api/moments` call per visible page).
  A fast flick costs zero network and zero RPC. This is the strongest part of
  the client design.
* **`feedPlayback`** — centre-biased distance ranking; ≤3 concurrent decoders
  and ≤5 buffered on constrained surfaces, uncapped on standalone desktop;
  yields entirely to a committed/detail video.
* **SSR seeding** (`app/page.tsx`) — the featured tab's two payloads are
  self-fetched with a 1s soft timeout that does *not* abort the underlying
  fetch (it still warms the Data Cache). A seeded `FeaturedFeed` fires no
  client fetches at all.

---

## 4. Findings

Ranked by expected impact. Each is verified against the code, not inferred.

### F1 · Rows past the page-1 sample depth are unreachable at *every* page · **correctness**

`app/api/timeline/route.ts:336-337, 375-376, 958-963` · `components/ProfileView.tsx:503,566`

For `collector=` and `creator=`, `needsLargerSample` is **false**, so
`baseSample = page × limit`. With `ProfileView`'s `limit=50` the fan-out samples
only each collection's **newest 50 moments**, *then* filters by membership.

The validation run showed this is worse than a missing-pagination problem. The
page number drives **both** the sample depth (`fetchLimit = page × limit`) **and**
the slice offset (`start = (page - 1) × limit`) — but the slice is taken over the
*filtered* set, which stays tiny. So a row deep enough to need page N to enter
the sample is, at page N, already past the slice window. It is unreachable at
every page.

Modelled against the route's verbatim formulas — one 400-moment collection, the
artist owning tokens at depths 101 / 341 / 396, `creator=`, `limit=18`:

```
page  fetchLimit  artist rows in sample  filtered set  slice window   returned
   1          18                      0             0  [0,18)               0
   6         108                      1             1  [90,108)             0
  19         342                      2             2  [324,342)            0
  22         396                      3             3  [378,396)            0
```

Reachable across pages 1–25: **none**. And page 1 reports `total_pages: 1`, so a
paginating client is never offered page 2 either.

Same shape on the Collected tab — of four items collected from a 400-moment
collection (depths 1 / 61 / 301 / 396), the feed returned **1 of 4**. Depth
degrades further as the tracked set grows: at 400 tracked collections
`perCollectionCap` is 25, so `fetchLimit` drops to 25 even at `limit=50`.

The in-code note at `:355-360` ("Collector feeds don't need it — their fan-out is
already narrowed to `collectedCollections`") addresses **width**; the binding
constraint is **depth**, and widening the budget does not move it.

*Fix:* decouple sample depth from the page number for post-merge-filtered feeds.
For `collector=` the membership set is already known exactly — resolve those refs
directly rather than sampling-then-filtering. For `creator=`, add `creatorRaw` to
`needsLargerSample` so the 200 floor applies (a partial fix — it moves the cliff
from depth 50 to depth 200, it does not remove it).

### F2 · `/api/collections?feed=1` hydrates the entire catalogue per request, uncached · **cost**

`app/api/collections/route.ts:212-296` · `lib/saleConfig.ts:151,162,243`

`visible.map(...)` hydrates **every** curated collection before slicing the
page, and each hydration runs `loadCollectAllEligibility` twice (ETH + USDC).
`fetchEligibleTokens` does a `getBlock` plus a `multicall` each time, over
JSON-RPC POSTs that Next's Data Cache does not cache — and `lib/rpc.ts:22`
constructs `http()` with no `batch` option, so none of them coalesce. So one
request costs ≈ **4 RPC round trips per collection that has a visible moment**
(collections with none short-circuit before any RPC), plus 2N inprocess fetches
at `revalidate:60`.

The response sets **no cache header**, so it inherits Next's dynamic-route
`no-store` — unlike `/api/timeline`, every visitor pays it in full.

There is a second consumer I initially missed: `DiscoverFilters.tsx:404-417`
fetches the same endpoint each time the `/discover` filters drawer is opened —
and keeps only `{ contractAddress, label }`, discarding every eligibility field
the route just spent 4 RPC calls per collection computing.

*Fix:* hydrate only the page slice (sorting needs `created_at`, which the
`getCollectionMetaBatch` pin already supplies for pinned rows), and add
`public, s-maxage=30, stale-while-revalidate=120` — the payload is
viewer-independent. `/api/featured/collections-hydrated` already models the
right shape (`MAX_HYDRATED_COLLECTIONS = 20` + `revalidate = 30`), including
the note that the real fix is background pre-warming.

### F3 · Hidden-identity scrub fails **open**, contrary to its own comment · **privacy**

`lib/momentEnrichment.ts:34-39` → `lib/addressUnion.ts:133,143` →
`lib/hidden-profiles.ts:82-91`

The comment states: *"Fail policy matches the feed's other hide sets: a Redis
error rejects (fails closed) rather than leaking a hidden name during the
blip."* It does not. `fetchHiddenProfilesSet` catches and returns an **empty
set**, so during an Upstash blip a hidden creator's username and avatar are
overlaid onto every feed card for up to the 60s memo window.

The same comment's second clause ("the timeline route awaits the same memo, so
adding it here is free there") doesn't hold either — no caller on the timeline
path awaits `getHiddenIdentityClosure` except this function itself.

Note the asymmetry this creates inside one request: `getHiddenMomentsSet` /
`getHiddenCollectionsSet` use `strictRead` and **throw**, while
`getHiddenUsersSet` and the identity closure swallow. Two of the four hide
layers fail closed, two fail open.

*Fix:* either make `_buildHiddenIdentityClosure` use `strictRead` (matching the
comment and the sibling sets) or correct the comment and record the trade-off
explicitly. Same call for `getHiddenUsersSet` — its fail-open is at least
documented in place (`lib/hidden-users.ts:75-78`).

### F4 · Deep pages of a *sorted* feed can duplicate rows · **correctness**

`components/PaginatedGrid.tsx:213-219` · `app/api/timeline/route.ts:336-337`

`allItems` concatenates pages with **no dedupe**, and `getKey` is the React key.
Because the per-collection sample is `page × limit`, page N+1 is computed over a
*deeper merge* than page N. For newest-first that is safe (deeper only appends
older rows). For `trending` / `latest-sales` / `ending-soon` it is not: a
newly-sampled old row can rank *above* the previous page boundary, so a row
already rendered reappears in the next slice → duplicate React keys.

Trigger: `page × limit > 200` (the `baseSample` floor) — page 10 at `/discover`'s
desktop limit of 24, page 11 on mobile (20), page 13 at the home feed's 18, page
21 at the constrained 10.

Magnitude, measured against the model rather than assumed: **exactly one
duplicated slot (and one silently skipped row) per reordering row that enters the
widening sample** — 1 scored row deep in the catalogue → 1 duplicate over 20
pages; 50 → 50. The default newest-first feed is provably clean (0 duplicates
across 30 pages of a 600-moment collection), because deeper sampling can only
append older rows to the tail, leaving the prefix order-invariant. So this is a
sorted-feed-only defect, and a mild one — but it is real, and it produces
duplicate React keys.

*Fix:* dedupe by `getKey` when appending in `loadMore` (2 lines, fixes the
symptom for the live-data race too), and file cursor pagination behind
`SCALING.md` §B1.

### F5 · A client-side `filter` can strand the user on an empty page · **UX**

`components/PaginatedGrid.tsx:392-399` · `components/DiscoverPage.tsx:255-261, 726-741`

The load-more button renders only inside `visible.length > 0`. When the
caller-supplied `filter` empties a page, the grid shows its empty state and
offers **no way to reach page 2**, even with `currentPage < totalPages`.

Two of the three `filter` call sites are exposed. `ArtistsFeed`'s `creators=`
branch is **not** — the server already filters to the same artists, so a page can
only come back empty when there is genuinely nothing more (`total_pages: 1`). Its
`collection=` branch **is** (no server-side creator filter, so the client filter
can empty a full page of a busy collection), as is `CollectionsFeed` with
"following" on. `CollectionsFeed` compounds it — the empty copy reads *"no
collections yet"* rather than "no matches", and the predicate keys on
`default_admin.address`, which the KV-fallback row shape
(`app/api/collections/route.ts:72-88`) doesn't carry, so indexer-lagging
collections are always filtered out.

*Fix:* render the load-more row whenever `currentPage < totalPages` regardless
of `visible.length`, and give `CollectionsFeed` a filtered empty state.
(`DiscoverMarketView` already got this right by refusing to make the watchlist a
feed filter — same reasoning applies here.)

### F6 · The "following" pill silently lies in two ways · **UX**

`components/DiscoverPage.tsx:388-400, 427-431` · `app/api/timeline/route.ts:946-956`

1. With zero follows (or a failed `/api/follow` fetch), `apiUrl` falls back to
   the plain global feed while the pill still renders as ON.
2. Server-side `following=` is a **bubble-to-top**, not a filter — the feed
   still contains everyone. The pill's affordance reads as a filter.

*Fix:* disable/annotate the pill when the list is empty; relabel to
"following first", or make it an actual filter.

### F7 · `following=` is an unbounded querystring · **robustness**

`lib/follows.ts:34` (`smembers`, no cap) · `components/DiscoverPage.tsx:399`

Every followed address is joined into the URL. At ~43 bytes each, a few thousand
follows exceeds common 8–16KB request-line limits and the feed 431s with no
fallback path.

*Fix:* cap the list (say 500, matching the follow-graph caps elsewhere), or POST
the set / derive it server-side from the session.

### F8 · The featured tab shows at most 20 mints, and can drop pinned ones · **correctness**

`components/FeaturedFeed.tsx:93` · `app/page.tsx:53` · `app/api/timeline/route.ts:170-171, 336-337`

`/api/timeline?featured=1` is called with no `limit`, so it defaults to 20 and
`total_pages` is ignored — mints 21+ of a curated set (`MAX_FEATURED` is 1000)
never render. Separately, featuring is a *pin*, but the fan-out still recovers
pinned rows from a newest-first sample of `min(200, MERGE_BUDGET/N)`, so a pin
deeper than that vanishes from the tab it was pinned to. Measured cutoffs: depth
200 while ≤25 collections hold featured members, falling to 100 at 50 collections
and 50 at 100.

*Fix:* pass an explicit `limit` sized to the curation cap; for the pin-depth
case, resolve featured refs directly (the members are known) rather than
recovering them from a newest-first sample.

### F9 · `scope` on `/discover` is unreachable UI surface · **dead code**

`lib/discoverState.ts:26-27, 55, 111-112, 144, 169, 197, 209-215`

`scope` is parsed, canonicalised into the URL, sent to the API, counted by
`hasActiveFilters` (so it flips the empty state to "no matches for these
filters" + a Clear button) and reset by `clearedFilters` — but
`components/DiscoverFilters.tsx` has **no control for it**. It is reachable only
by hand-editing the URL.

*Fix:* add the pill (it's a genuinely useful axis — solo mints vs collections vs
everything) or drop the field.

### F10 · Per-collection Redis GET inside every fan-out leg · **cost**

`app/api/timeline/route.ts:132-136` · `lib/coverMomentSynthesis.ts:37`

`fetchCollection` calls `synthesizeMissingCoverMoment`, whose first act is
`getCollectionMeta(collection)` — one un-batched, un-memoized Redis GET **per
collection per request**, mostly to discover there is no `coverTokenId`. On the
no-store personal feeds that is N GETs on every profile view; auto-pipelining
only merges the legs that happen to land in the same tick.

*Fix:* hoist one `getCollectionMetaBatch(collections)` before the fan-out and
pass `coverTokenId` into `fetchCollection`. Single MGET, same behaviour.

### F11 · Secondary market feed: uncached, and capped at 500 live listings · **cost / correctness**

`app/api/listings/route.ts:445-473` · `lib/listings.ts:227, 270, 417-419`

* The marketplace branch sets **no `Cache-Control`** (only `keys=1` does), so
  every `/market` and `/discover?m=secondary` page view re-runs
  `scanActiveListings` (500-member zrange + MGET + predicate passes). The
  payload is viewer-independent apart from the visibility filter, which is
  itself global — so it is cacheable on the same terms as the timeline.
* `MAX_LISTINGS_SCAN = 500` is a hard ceiling on the *entire* book: listing 501+
  is unreachable through any page, and `total` is derived from the truncated
  scan.
* Visibility filtering runs **after** pagination (`:460-464`, acknowledged
  in-code), so pages render short and `total` overcounts.

*Fix:* add the shared cache header; filter before slicing; raise/cursor the scan
before the book approaches 500.

### F12 · A hidden-set blip takes the whole feed down, not just the filter · **resilience**

`app/api/timeline/route.ts:843-848` · `lib/hiddenMoments.ts:55`

`getHiddenMomentsSet` / `getHiddenCollectionsSet` throw by design (correct — a
blip must never reveal hidden work), but they're awaited bare inside the handler,
so the failure surfaces as a **500 on every feed**. Compare the created-mints
membership read (`:559-561`), which catches and degrades to an unfiltered page
with a warn.

Not necessarily wrong — failing closed on hidden content is the right call — but
it deserves to be a deliberate, documented choice with a 503 + retry-friendly
response rather than an unhandled throw.

### F13 · `artist=` on `/discover` shows the artist their own hidden work, unbadged · **minor**

`lib/discoverState.ts:175` · `app/api/timeline/route.ts:854-872` ·
`components/MarketOvals.tsx`

`primaryApiUrl` maps the artist pill to `creator=`, which makes the request
viewer-dependent and enables the own-profile exception. So an artist filtering
`/discover` to themselves sees their hidden pieces inline — and `MomentOval`
(unlike `MomentCard:581-585`) renders no hidden badge, so they're
indistinguishable from live work.

*Fix:* either scope the own-profile exception to the profile route, or give the
oval the same `EyeOff` badge.

### F14 · Stale comment: `fresh` does **not** ride the react-query key · **docs**

`lib/paginatedGridQuery.ts:49-54` vs `components/PaginatedGrid.tsx:134-160`

The comment claims *"The param rides the URL so it's also the react-query key of
the refetch — it never pollutes the normal cached feed's entry."* In the actual
implementation the key is `paginatedQueryKey(firstPageUrl)` (no `fresh`) and the
queryFn appends `fresh=1` internally via `forceFreshRef`, so the refresh
deliberately **does** write into the normal entry. The behaviour is right; the
comment describes a superseded design.

### F15 · `SCALING.md` §2 line references have drifted · **docs**

Cited `timeline/route.ts:44, 74, 276-294` are now `:52` (`FANOUT_CONCURRENCY`),
`:115` (the 8s abort), `:361-384` (budget/truncation/warn). Worth a pass, since
this is the doc an on-call reader follows first. `diagnose-feed-visibility.mjs`
is also missing a gate: it probes upstream at `limit=200` (`:191`), which is
*deeper* than what the route actually samples for a profile feed (50), so it can
report G2 PASS for a row the feed never sees — exactly the F1 blind spot.

---

## 5. Validation

Every finding above was re-derived adversarially rather than left as a reading.
Method, and what it changed:

**Executable model.** `app/api/timeline/route.ts`'s sampling → merge → sort →
slice pipeline was reimplemented with the formulas copied verbatim (`:170-171`,
`:336-337`, `:361`, `:375-376`, `:730-764`, `:821-828`, `:958-963`), driven by a
synthetic catalogue, with upstream modelled exactly as inprocess behaves
(`GET /timeline?collection=X&limit=L` → that collection's newest L). This is what
proved F1's unreachable-at-every-page property, bounded F4's magnitude, and
produced F8's depth cutoffs.

**Mechanical assertions.** 41 grep/awk assertions over the real source — payload
shapes, guard nesting, header presence, call ordering, failure modes — covering
F2, F3, F5, F6, F7, F8, F9, F11, F12, F13, F14. All 41 hold. Four of them were
convoluted enough to be weak evidence, so they were re-checked by hand
(`scope` in the discover UI, the bare hidden-set `await`, the KV fallback row
shape, and whether `MarketOvals` reads `moment.hidden` at all).

**What validation changed:**

| | outcome |
|---|---|
| F1 | **strengthened** — not "the profile tab doesn't paginate" but "unreachable at every page"; depth and slice offset advance together |
| F2 | **widened** — a second consumer (the `/discover` filters drawer) pays the full cost for two fields; RPC count qualified to collections *with* visible moments |
| F4 | **narrowed** — real, but one duplicated slot per reordering row, only past page ⌈200/limit⌉; newest-first proven clean |
| F5 | **narrowed** — `ArtistsFeed`'s `creators=` branch is not exposed; only its `collection=` branch and `CollectionsFeed`+following are |
| F8 | **quantified** — exact pin-depth cutoffs (200 → 100 → 50 as the featured-collection count passes 25 → 50 → 100) |
| F15 | **self-correction** — my own cited range was wrong (`:361-384`, not `:368-384`) |
| F3, F6, F7, F9–F14 | confirmed as written |
| — | nothing was refuted |

Two corrections to the work itself: the first duplicate-count harness assumed
every page returns a full `limit` and over-counted once the walk ran past the
catalogue (fixed by counting actual rows — this is what turned an apparent "120
duplicates on the default feed" into the correct 0); and the first assertion
runner used `eval` in the current shell, so an `exit` inside a check aborted the
suite after two lines.

**Limit of this validation.** `kismet.art` is blocked by this environment's
network policy, so nothing was checked against production data. Every finding is
therefore stated with its *trigger condition* rather than an observed frequency:
F1 needs a collection holding more than `limit` moments newer than the target,
F4 needs a catalogue deeper than 200 plus a user paging past it, F8's second half
needs a pinned mint deeper than 200. Whether those hold today is a question of
the live catalogue's shape — `scripts/diagnose-feed-visibility.mjs` plus a
`SCARD kismetart:collections` would settle it in a minute against real Redis.

## 6. What's working well

Worth stating plainly, because the density of correct detail here is unusual:

* **Fail-closed discipline** on browse filters — `free`, `media`, `resale`,
  `soldout` all exclude what they cannot classify, and the on-chain sold-out
  read is bounded three ways (row cap, 2s timeout, edge cache) with the
  polarity flipped correctly between ending-soon (fail-open) and `soldout=1`
  (fail-closed).
* **`normalizeHiddenFlag` runs unconditionally** — Kismet owns the `hidden`
  field, upstream values are stripped even when every hide set is empty. That
  closes a real leak, and `visibleToPublic` is a clean consumer of the contract.
* **Creator attribution has one resolver** (`resolveMomentCreator`) shared by
  the feed, the stats rebuild and the detail view, and the stitch runs *before*
  every filter that reads `creator.address`.
* **`getCreatedMintsMembership`** is bounded SMISMEMBER over just the request's
  candidates, with the no-try/catch failure contract deliberately preserved so
  the caller can degrade — and the reasoning (Upstash's 10MB cap at ~200k mints)
  is written down.
* **The dwell-gate + batch-loader pair** is the right answer to per-card fetch
  storms, and it's applied consistently across cards and ovals.
* **`lib/discoverState.ts` is framework-free on purpose** (with the production
  500 digest that forced it recorded), `reconcileState` runs on both parse and
  update, and `discoverUrl` fixes param order so equal states share one cache
  family.
* **The off-platform admission rule** is a small, epoch-pinned, CI-locked
  policy (`verify-feed-admission.ts`, 12/12 passing on this tree) with the
  incident that motivated it cited in the source.
* **Video/decoder budgeting** distinguishes standalone desktop from
  iframe/RN-webview rather than from UA alone — the surface matrix that
  `verify-surfaces.ts` pins.

## 7. Suggested order of work

Re-ranked after validation — F1 moved up (it is worse than first written), F4
moved down (it is milder).

1. **F1** — the only finding that loses data outright, on the two most personal
   surfaces, with no page the user can reach to recover it. The cheap partial fix
   (add `creatorRaw` to `needsLargerSample`) moves the cliff from depth 50 to 200
   in one line; the real fix is resolving `collector=` refs directly, since the
   membership set is already known exactly.
2. **F2** — the largest uncached per-request cost on the platform, now with two
   consumers, one of which uses two fields out of the payload. Slice before
   hydrating, add the shared cache header.
3. **F3** — small, privacy-shaped, and actively mis-documented, which is the part
   that makes it worth doing now rather than later.
4. **F5** (filtered-empty stranding) and **F8a** (the defaulted `limit=20` on the
   featured tab) — both are one-liners with user-visible consequences.
5. **F11** (listings cache + the 500 ceiling), **F10** (batch the per-leg meta
   read into one MGET).
6. **F4** (cross-page duplicates) — a 2-line dedupe on append; low severity but
   the fix is smaller than the analysis.
7. **F6, F7, F9, F13** (truth-in-labelling, the unbounded querystring, dead
   surface), then **F14, F15** (comment and doc drift).

None of these change the architecture. The architecture item remains
`SCALING.md` §B1 — a materialized per-scope feed replaces fan-out-on-read, makes
personalized feeds cacheable, and dissolves F1, F4 and F8b outright: all three
are artifacts of recovering specific rows from a newest-first sample instead of
addressing them directly.
