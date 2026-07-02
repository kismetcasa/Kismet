import { redis, SALE_ENDS_KEY } from './redis'
import { OPEN_ENDED_SALE_SENTINEL } from './inprocess'

// Sale-end index for the ending-soon feed. One zset: member "collection:tokenId",
// score = saleEnd in unix SECONDS (on-chain saleEnd is already seconds, and
// float64 zset scores hold them exactly). Only REAL deadlines are stored —
// open-ended sales (saleEnd 0 / absent / max-uint64 sentinel) are removed, so
// a BYSCORE read over [now, +inf) is exactly "live-or-scheduled sales with a
// deadline, soonest first" with no post-filtering.

// Same ceiling as the trending zsets: far above what any feed page shows,
// bounds the zset against unbounded growth.
const MAX_SALE_ENDS = 10_000

// How long an ended sale lingers before the write-side sweep removes it.
// Reads never see ended entries regardless (BYSCORE starts at `now`); the
// grace only avoids churning members whose sale might be extended right at
// the boundary.
const ENDED_SWEEP_GRACE_SEC = 24 * 60 * 60

/**
 * Parse a saleConfig.saleEnd string to a real deadline in unix seconds, or
 * null when the sale is open-ended (0 / sentinel / non-numeric / absent) —
 * the same classification getSaleWindow applies for display.
 */
export function parseRealSaleEnd(saleEnd: string | undefined | null): number | null {
  if (!saleEnd) return null
  try {
    const end = BigInt(saleEnd)
    if (end > 0n && end < OPEN_ENDED_SALE_SENTINEL) return Number(end)
  } catch {
    // non-numeric → treat as open-ended
  }
  return null
}

/**
 * Write-through from resolved sale configs (the /api/moments batch): index
 * every real deadline, un-index members whose sale is now open-ended (a
 * creator can rewrite the sale row on-chain), and leave unknowns (null
 * config — upstream blip) untouched so a transient error can't erase data.
 *
 * Piggybacks the bounded sweeps on the same pipeline: drop entries whose
 * sale ended > grace ago, and cap cardinality keeping the SOONEST ends
 * (rank trims from the top — farthest-future deadlines are the least
 * urgent to show). Auto-pipelining collapses this into the request's
 * existing Redis round trip; callers fire-and-forget.
 */
export async function recordSaleEnds(
  entries: { key: string; saleEnd: string | undefined | null; known: boolean }[],
): Promise<void> {
  const toAdd: { score: number; member: string }[] = []
  const toRemove: string[] = []
  for (const e of entries) {
    if (!e.known) continue
    const end = parseRealSaleEnd(e.saleEnd)
    if (end !== null) toAdd.push({ score: end, member: e.key })
    else toRemove.push(e.key)
  }
  if (toAdd.length === 0 && toRemove.length === 0) return

  const pipeline = redis.multi()
  if (toAdd.length > 0) {
    pipeline.zadd(SALE_ENDS_KEY, toAdd[0], ...toAdd.slice(1))
  }
  if (toRemove.length > 0) {
    pipeline.zrem(SALE_ENDS_KEY, ...toRemove)
  }
  const sweepBefore = Math.floor(Date.now() / 1000) - ENDED_SWEEP_GRACE_SEC
  pipeline.zremrangebyscore(SALE_ENDS_KEY, 0, sweepBefore)
  pipeline.zremrangebyrank(SALE_ENDS_KEY, MAX_SALE_ENDS, -1)
  await pipeline.exec()
}

/**
 * The upcoming deadlines, soonest first: member → saleEnd (unix seconds),
 * only entries with saleEnd >= nowSec. Map iteration order preserves the
 * ascending BYSCORE order, so callers can rank by lookup. Empty map on any
 * Redis failure — the ending-soon sort degrades to newest-first rather
 * than failing the feed.
 */
export async function getUpcomingSaleEnds(nowSec: number): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const raw = (await redis.zrange(SALE_ENDS_KEY, nowSec, '+inf', {
      byScore: true,
      withScores: true,
      offset: 0,
      count: MAX_SALE_ENDS,
    })) as (string | number)[]
    for (let i = 0; i + 1 < raw.length; i += 2) {
      map.set(String(raw[i]), Number(raw[i + 1]))
    }
  } catch {
    // degrade to empty — caller falls back to newest-first
  }
  return map
}
