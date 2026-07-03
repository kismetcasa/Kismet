import { Redis } from '@upstash/redis'

const url = process.env.UPSTASH_REDIS_REST_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN

// Warn-and-continue rather than throw: Next.js's `Collecting page data`
// pass loads route modules during build and top-level env reads can
// happen before the build environment is fully populated. Throwing here
// would kill the build; a placeholder lets it complete, and any actual
// Redis call at runtime will surface the misconfig via Upstash's own
// error path.
//
// Guard the warn to server-only (typeof window === 'undefined'): if a
// client component imports this module transitively, the env vars are
// stripped from the client bundle (no NEXT_PUBLIC_ prefix) and the
// warn fires every page load — which doesn't reflect anything broken
// (the server has the env vars, that's where Redis actually runs) and
// just pollutes diagnostic consoles for users trying to debug the app.
if (typeof window === 'undefined' && (!url || !token)) {
  console.warn(
    '[redis] UPSTASH_REDIS_REST_URL/TOKEN not set — Redis calls will fail at runtime',
  )
}

export const redis = new Redis({
  url: url ?? 'https://placeholder.upstash.io',
  token: token ?? 'placeholder',
  // Auto-batch commands issued in the same tick (every `Promise.all([...])` of
  // Redis calls, and any per-item fan-out loop) into ONE REST round trip instead
  // of N. Upstash REST has real per-call latency, so this is the single highest-
  // leverage optimization — it collapses the notification/airdrop fan-outs and
  // dozens of parallel-read sites for free. Per-command promises still resolve/
  // reject individually, so existing per-call `.catch()`/`safeRead` handling is
  // unchanged; explicit `multi()`/`eval` (rate limit, graph writes) are atomic
  // and unaffected.
  enableAutoPipelining: true,
})

export const FEATURED_KEY = 'kismetart:featured'
export const FEATURED_COLLECTIONS_KEY = 'kismetart:featured-collections'
// Mint Pass Display — individual mints curated to render at collection scale
// (a full-bleed showcase) atop the featured tab. A SUBSET of FEATURED_KEY
// (DISPLAY ⊆ FEATURED): promoting writes the member to BOTH sets, so demoting
// it (zrem from this set only) leaves it an ordinary featured card instead of
// dropping it from the tab. Single display at a time — promoting clears this
// set first (see /api/featured POST).
export const FEATURED_MOMENT_DISPLAYS_KEY = 'kismetart:featured-moment-displays'
export const TRENDING_KEY = 'kismetart:trending'
// Latest-sales feed: member = "collection:tokenId", score = timestamp (ms) of
// the most recent verified collect. Written alongside TRENDING_KEY's zincrby
// in /api/collect (zadd overwrites — last collect wins) with the same 10k
// write-side rank trim, so the two feed zsets stay cost-identical.
export const TRENDING_LATEST_KEY = 'kismetart:trending-latest'
// Ending-soon feed: member = "collection:tokenId", score = on-chain saleEnd
// (unix seconds). Populated write-through by /api/moments — the batch
// sale-config endpoint every feed card already hits for its price badge — so
// it self-backfills as users browse, with zero new upstream fan-out. Reads
// take only future ends (ZRANGE BYSCORE now→+inf); see lib/saleEnds.ts.
export const SALE_ENDS_KEY = 'kismetart:sale-ends'

/**
 * Build a member → score Map from a `zrange(..., { withScores: true })` reply
 * (a flat alternating [member, score, member, score, …] array). Map insertion
 * order preserves the zrange order, so callers can also rely on iteration
 * order (e.g. ascending BYSCORE reads). One place encodes the flat-pair shape
 * instead of a hand-rolled loop per read site.
 */
export function zpairsToMap(raw: (string | number)[]): Map<string, number> {
  const map = new Map<string, number>()
  for (let i = 0; i + 1 < raw.length; i += 2) {
    map.set(String(raw[i]), Number(raw[i + 1]))
  }
  return map
}

// Ceiling for the featured zsets — trimmed on every write (mirroring the
// TRENDING 10k cap in /api/collect) and used to bound every read. Featuring is
// a manual curator action so growth is slow, but these keys were the only
// zsets with neither a write trim nor a bounded read: each unbounded
// `zrange(0, -1)` grows toward Upstash's 10MB per-request cap and an O(N)
// read forever. Far above anything the UI shows, so the cap never bites a
// legitimate curation.
export const MAX_FEATURED = 1000
