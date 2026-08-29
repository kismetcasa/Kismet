// Pure pagination decisions shared by the feed route and the grid that renders
// it. Deliberately dependency-free — no Redis, no React, no env — for the same
// reason lib/showcaseOrder.ts is: a client component can import it without
// dragging server modules toward the bundle, and scripts/verify-feed-pagination
// can exercise every rule in CI with plain `node`.

/**
 * Per-collection sample depth for a feed whose post-merge filter THINS the
 * merged set. Page-independent by construction, which is the entire point.
 *
 * The feed route re-derives its whole merge per request at a depth of
 * `page * limit`, then slices `[(page-1)*limit, page*limit)`. When a filter
 * survives only a small subset, those two walk DIFFERENT sets — the sample
 * walks the upstream, the slice walks the thinned result — so a row deep
 * enough to need page N to enter the sample is, at page N, already past that
 * page's window. It is then unreachable at EVERY page, and page 1 reports
 * `total_pages: 1`, so a paginating client never even asks for page 2.
 * (Measured against the route's own formulas: an artist's mints at depth
 * 101/341/396 of a 400-row collection were returned by none of pages 1-25.)
 *
 * 200 matches SORTED_SAMPLE_FLOOR so that no caller's first page gets a
 * SHALLOWER sample than it had before this rule existed. It is still passed
 * through `min(..., MERGE_BUDGET/N)` at the call site, so the merge stays
 * inside its budget however wide the tracked set grows.
 */
export const THINNED_SAMPLE_DEPTH = 200

/**
 * Floor for a cross-collection SORT. A sort reorders the whole merge (a
 * recently-sold or soon-ending moment can sit deep in its collection's
 * newest-first timeline), so one page's worth of depth would rank off an
 * unrepresentative sample. Unlike the thinned case this floor still GROWS with
 * `page`: a sorted feed is not thinned, so deeper pages are exactly how it
 * reaches more content, and growing the sample is what makes that possible.
 */
export const SORTED_SAMPLE_FLOOR = 200

export interface FeedSampleInput {
  page: number
  limit: number
  /** A cross-collection sort mode is active (trending / latest-sales / ending-soon). */
  sorted: boolean
  /** A post-merge filter keeps only a subset of the merge (featured curation,
   *  the creators roster, or a personal creator=/collector=/airdroppable= feed). */
  thinned: boolean
}

/**
 * How deep to sample EACH collection in the fan-out, before the caller bounds
 * it by the merge budget. Thinning wins when a request is both — the roster
 * feed is `creators=` plus `sort=trending` — because the thinned set is the one
 * pagination actually slices.
 */
export function feedSampleDepth({ page, limit, sorted, thinned }: FeedSampleInput): number {
  if (thinned) return THINNED_SAMPLE_DEPTH
  if (sorted) return Math.max(page * limit, SORTED_SAMPLE_FLOOR)
  return page * limit
}

/**
 * First occurrence of each render key wins — the earlier page keeps the slot
 * the reader has already seen and scrolled past.
 *
 * Offset pagination over a live, re-derived result set can hand back a row an
 * earlier page already rendered, and an append-only list turns that into a
 * repeated React key. On a SORTED feed the route's widening sample is enough on
 * its own: a newly-sampled older row can outrank the previous page boundary and
 * shift exactly one row across it per reordering row that enters (first
 * reachable at page ceil(SORTED_SAMPLE_FLOOR/limit)+1). Newest-first feeds are
 * provably clean — a deeper sample only appends older rows to the tail — so
 * this is a guard, not a hot path.
 *
 * Returns the SAME array reference when there is nothing to drop (the
 * overwhelming case), so the common render costs one pass and no allocation.
 */
export function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  for (const it of items) seen.add(keyOf(it))
  if (seen.size === items.length) return items
  const kept = new Set<string>()
  return items.filter((it) => {
    const k = keyOf(it)
    if (kept.has(k)) return false
    kept.add(k)
    return true
  })
}

/**
 * How many featured mints the featured tab renders.
 *
 * Lives HERE, not in components/FeaturedFeed, because app/page.tsx is a Server
 * Component: every export of a `'use client'` module reaches a server module as
 * an opaque client reference, which is the exact trap lib/discoverState.ts
 * documents (the production /discover 500, digest 1841440540). A type-only
 * import is erased and stays safe; a value import would not be.
 *
 * The request used to carry no `limit` at all, so it silently took
 * /api/timeline's default of 20 — curate a 21st mint and it never appeared,
 * with no empty state and no "load more" (FeaturedFeed reads `.moments` and
 * ignores `pagination`). 100 is the route's own `limit` ceiling, i.e. the most
 * one page can serve, and it costs nothing upstream: a featured request samples
 * at THINNED_SAMPLE_DEPTH regardless of `limit`. Both the client fetch and the
 * SSR seed in app/page.tsx must use it — a seeded FeaturedFeed renders its
 * payload verbatim and never re-fetches, so a smaller seed would re-cap the tab.
 */
export const FEATURED_RENDER_LIMIT = 100
