import { redis, SALE_ENDS_KEY, zpairsToMap } from './redis'
import { parseRealSaleEnd } from './inprocess'

// Sale-end index for the ending-soon feed. One zset: member "collection:tokenId"
// (tokenId in BigInt-canonical decimal, matching /api/collect's trending
// members and the timeline's token_id lookup keys), score = saleEnd in unix
// SECONDS (on-chain saleEnd is already seconds, and float64 zset scores hold
// them exactly). Only REAL deadlines are stored — open-ended sales are
// removed — so a BYSCORE read over [now, +inf) is exactly "live-or-scheduled
// sales with a deadline, soonest first" with no post-filtering.

// Same ceiling as the trending zsets: far above what any feed page shows,
// bounds the zset against unbounded growth.
const MAX_SALE_ENDS = 10_000

// How long an ended sale lingers before the write-side sweep removes it.
// Reads never see ended entries regardless (BYSCORE starts at `now`); the
// grace only avoids churning members whose sale might be extended right at
// the boundary.
const ENDED_SWEEP_GRACE_SEC = 24 * 60 * 60

// Run the two housekeeping sweeps (ended-entry purge + cardinality cap) at
// most once per interval per pod instead of on every write — they're near-
// permanent no-ops, and per-command billing makes a 2-command tax on every
// batch pure waste. Same throttle pattern as the timeline route's thinning
// warning.
const SWEEP_INTERVAL_MS = 5 * 60_000
let lastSweepAt = 0

// Per-pod memory of what this process already indexed (key → saleEnd). An
// on-chain saleEnd is immutable in the common case, so /api/moments would
// otherwise re-ZADD identical members on every uncached batch — this skips
// those. Bounded: cleared wholesale at the cap (simpler than LRU, and a
// clear only costs some redundant re-adds). Skips apply to ADDS only —
// removals always go to Redis, since another pod (or a restart) may have
// indexed the member.
const MAX_SEEN = 20_000
const seenEnds = new Map<string, number>()

/**
 * Write-through from resolved sale configs (the /api/moments and /api/moment
 * price paths): index every real deadline, and un-index members whose
 * saleEnd field EXPLICITLY names no deadline ("0" / the open-ended sentinel /
 * non-numeric). Two shapes are deliberately left untouched:
 *   - config === null (upstream blip / unknown) — a transient error must
 *     never erase live index entries;
 *   - config without a saleEnd field (partial upstream data) — ambiguous,
 *     and an entry only ever enters the index with a real end, so a sale
 *     that later becomes genuinely open-ended arrives with the sentinel
 *     present and still gets removed.
 *
 * Housekeeping sweeps piggyback on the same pipeline, throttled per pod.
 * The whole write is one atomic multi() — a single Upstash REST round trip
 * (multi() is not merged by auto-pipelining; see lib/redis.ts) — and callers
 * fire-and-forget via after(), so it never adds request latency.
 */
export async function recordSaleEnds(
  entries: { key: string; config: { saleEnd?: string } | null }[],
): Promise<void> {
  const toAdd: { score: number; member: string }[] = []
  const toRemove: string[] = []
  for (const e of entries) {
    if (!e.config || e.config.saleEnd === undefined) continue
    const end = parseRealSaleEnd(e.config.saleEnd)
    if (end !== null) {
      if (seenEnds.get(e.key) !== end) toAdd.push({ score: end, member: e.key })
    } else {
      toRemove.push(e.key)
    }
  }

  const sweepDue = Date.now() - lastSweepAt > SWEEP_INTERVAL_MS
  if (toAdd.length === 0 && toRemove.length === 0 && !sweepDue) return

  const pipeline = redis.multi()
  if (toAdd.length > 0) {
    pipeline.zadd(SALE_ENDS_KEY, toAdd[0], ...toAdd.slice(1))
  }
  if (toRemove.length > 0) {
    pipeline.zrem(SALE_ENDS_KEY, ...toRemove)
  }
  if (sweepDue) {
    lastSweepAt = Date.now()
    pipeline.zremrangebyscore(
      SALE_ENDS_KEY,
      0,
      Math.floor(Date.now() / 1000) - ENDED_SWEEP_GRACE_SEC,
    )
    // Rank 0 is the LOWEST score (soonest end) — trim from the top so the
    // cap evicts the farthest-future deadlines, the least urgent to show.
    pipeline.zremrangebyrank(SALE_ENDS_KEY, MAX_SALE_ENDS, -1)
  }
  await pipeline.exec()

  // Update the per-pod memory only after the write succeeded, so a failed
  // pipeline retries the adds on the next batch instead of skipping them.
  if (seenEnds.size + toAdd.length > MAX_SEEN) seenEnds.clear()
  for (const a of toAdd) seenEnds.set(a.member, a.score)
  for (const k of toRemove) seenEnds.delete(k)
}

/**
 * The upcoming deadlines, soonest first: member → saleEnd (unix seconds),
 * only entries with saleEnd >= nowSec. Map iteration order preserves the
 * ascending BYSCORE order. Empty map on any Redis failure — the ending-soon
 * sort degrades to newest-first rather than failing the feed.
 */
export async function getUpcomingSaleEnds(nowSec: number): Promise<Map<string, number>> {
  try {
    const raw = (await redis.zrange(SALE_ENDS_KEY, nowSec, '+inf', {
      byScore: true,
      withScores: true,
      offset: 0,
      count: MAX_SALE_ENDS,
    })) as (string | number)[]
    return zpairsToMap(raw)
  } catch {
    // degrade to empty — caller falls back to newest-first
    return new Map()
  }
}
