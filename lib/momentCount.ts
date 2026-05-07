import { redis } from './redis'
import { INPROCESS_API } from './inprocess'

// Discovery-feed filter: a "real" collection has more than the auto-deploy
// default of one moment. Hard-coded rather than configurable to avoid an
// undocumented query-string flag becoming a stealth filter-bypass.
export const MIN_MOMENTS_FOR_FEED = 2

// Long enough to keep inprocess /timeline traffic well-bounded, short enough
// that off-Kismet mints (which we don't see and can't explicitly invalidate)
// surface within minutes. Mints made through Kismet invalidate the entry
// directly via invalidateMomentCount, so the TTL only governs the secondary
// drift cases.
const CACHE_TTL_SECONDS = 300

const cacheKey = (address: string) =>
  `kismetart:moment-count-qualifies:${address.toLowerCase()}`

// Boolean stored as 1/0 — Upstash returns it as number on read, which we
// re-narrow below. Storing the raw count would let us reuse the value if the
// threshold ever changed, but we cap reads at limit=MIN_MOMENTS_FOR_FEED so
// the count we'd cache is already saturating; the boolean is the honest shape.
async function fetchQualifies(address: string): Promise<boolean> {
  const url = new URL(`${INPROCESS_API}/timeline`)
  url.searchParams.set('collection', address)
  url.searchParams.set('chain_id', '8453')
  url.searchParams.set('limit', String(MIN_MOMENTS_FOR_FEED))
  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`inprocess /timeline ${res.status}`)
  const data = (await res.json()) as { moments?: unknown }
  const count = Array.isArray(data.moments) ? data.moments.length : 0
  return count >= MIN_MOMENTS_FOR_FEED
}

/**
 * For each address, returns whether it qualifies for the discover feed
 * (moment count >= MIN_MOMENTS_FOR_FEED). Reads from Redis first; misses
 * fan out to inprocess in parallel.
 *
 * Fail-open semantics: if inprocess errors or Redis is unreachable, the
 * collection is treated as qualifying. The filter is a quality enhancement,
 * not a correctness gate — we'd rather show single-moment collections during
 * an outage than empty the discover feed.
 */
export async function qualifiesForFeedBatch(
  addresses: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>()
  if (addresses.length === 0) return result

  let cached: (number | string | null)[]
  try {
    cached = await redis.mget<(number | string | null)[]>(
      ...addresses.map(cacheKey),
    )
  } catch {
    cached = addresses.map(() => null)
  }

  const missing: string[] = []
  for (let i = 0; i < addresses.length; i++) {
    const lower = addresses[i].toLowerCase()
    const v = cached[i]
    if (v === 1 || v === '1') {
      result.set(lower, true)
    } else if (v === 0 || v === '0') {
      result.set(lower, false)
    } else {
      missing.push(addresses[i])
    }
  }

  await Promise.all(
    missing.map(async (address) => {
      const lower = address.toLowerCase()
      try {
        const qualifies = await fetchQualifies(address)
        result.set(lower, qualifies)
        try {
          await redis.set(cacheKey(address), qualifies ? 1 : 0, {
            ex: CACHE_TTL_SECONDS,
          })
        } catch {
          // Cache-write failure is non-fatal: the in-memory result is
          // correct for this request, and the next request just re-fetches.
        }
      } catch {
        // Fail-open: include collections we couldn't classify.
        result.set(lower, true)
      }
    }),
  )

  return result
}

/**
 * Drop the cached qualification for a collection. Called from mint-proxy
 * after a successful mint so a 1→2 promotion surfaces in the feed on the
 * next request rather than waiting for TTL.
 */
export async function invalidateMomentCount(address: string): Promise<void> {
  try {
    await redis.del(cacheKey(address))
  } catch {
    // Non-fatal — TTL will still catch up within CACHE_TTL_SECONDS.
  }
}
