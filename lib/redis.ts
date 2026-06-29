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
// Per-moment raffle enablement. A zset of `<addr>:<tokenId>` members (score =
// enabledAt) marking which mints have a raffle (active or ended). The moment's
// creator/admin toggles it per moment via the signed /api/raffle/manage route;
// the client learns the whole set once on mount (AdminContext.raffleEnabledKeys),
// the same way it learns FEATURED_KEY, so owned-edition surfaces can choose
// "enter raffle" vs "list" synchronously.
export const RAFFLE_ENABLED_KEY = 'kismetart:raffle-enabled'
