import { redis, SALE_ENDS_KEY, SALE_FREE_KEY, zpairsToMap } from './redis'
import { parseRealSaleEnd, isZeroPrice } from './inprocess'

// Sale-end index for the ending-soon feed. One zset: member "collection:tokenId"
// (tokenId in BigInt-canonical decimal, matching /api/collect's trending
// members and the timeline's token_id lookup keys), score = saleEnd in unix
// SECONDS (on-chain saleEnd is already seconds, and float64 zset scores hold
// them exactly). Only ACTIVE window sales are stored — a member is indexed only
// when it has a REAL deadline AND has already started (saleStart <= now); an
// open-ended, ended, or not-yet-started (scheduled) sale is removed — so a
// BYSCORE read over [now, +inf) is exactly "sales inside their window right now,
// soonest close first" with no post-filtering.

// Same ceiling as the trending zsets: far above what any feed page shows,
// bounds the zset against unbounded growth.
const MAX_SALE_ENDS = 10_000
// Free-mint index shares the same ceiling. Scored by index time (ms) so the
// cardinality trim evicts the least-recently-indexed free mint first.
const MAX_FREE = 10_000

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
// Per-pod memory of the free/priced verdict (key → isFree) — same purpose as
// seenEnds: skip re-writing a member whose verdict is unchanged. Unlike the
// ends index we also cache the PRICED verdict (false), so the common priced
// moment isn't zrem'd on every batch. Correctness still holds: every pod, on
// its FIRST priced sighting of a member (verdict absent → zrem), clears any
// stale free entry another pod (since restarted) may have written, and reads
// always hit Redis so a stale write-cache can only cost a redundant write.
const seenFree = new Map<string, boolean>()

/**
 * Write-through from resolved sale configs (the /api/moments and /api/moment
 * price paths): maintain two indexes in one atomic pipeline.
 *
 * Ending-soon (SALE_ENDS_KEY): index a member's real deadline only while the
 * sale is ACTIVE — it has a real close date AND has already started
 * (saleStart <= now; absent/"0" saleStart = opens-now). A member is un-indexed
 * when its saleEnd EXPLICITLY names no deadline ("0" / the open-ended sentinel /
 * non-numeric) OR the sale hasn't started yet (scheduled) — neither is inside a
 * window right now. A scheduled sale re-indexes once it opens and is browsed
 * again. Left untouched: config without a saleEnd field (ambiguous partial data).
 *
 * Free-mint (SALE_FREE_KEY): a member with pricePerToken == 0 is a free mint,
 * not a sale — index it so the Latest/Most Sales feeds can filter it out; a
 * priced member (> 0) is un-indexed. An absent/non-numeric price is left
 * untouched (ambiguous).
 *
 * Both indexes leave config === null untouched — a transient upstream blip must
 * never erase a live entry. Housekeeping sweeps piggyback on the same pipeline,
 * throttled per pod. The whole write is one atomic multi() — a single Upstash
 * REST round trip (multi() is not merged by auto-pipelining; see lib/redis.ts) —
 * and callers fire-and-forget via after(), so it never adds request latency.
 */
export async function recordSaleEnds(
  entries: {
    key: string
    config: { saleStart?: string; saleEnd?: string; pricePerToken?: string } | null
  }[],
): Promise<void> {
  const nowMs = Date.now()
  const nowSec = Math.floor(nowMs / 1000)
  const toAdd: { score: number; member: string }[] = []
  const toRemove: string[] = []
  const toAddFree: { score: number; member: string }[] = []
  const toRemoveFree: string[] = []
  for (const e of entries) {
    if (!e.config) continue

    // Ending-soon index — active window sales only.
    if (e.config.saleEnd !== undefined) {
      const end = parseRealSaleEnd(e.config.saleEnd)
      const startNum = e.config.saleStart ? Number(e.config.saleStart) : 0
      const started = Number.isFinite(startNum) && startNum <= nowSec
      if (end !== null && started) {
        if (seenEnds.get(e.key) !== end) toAdd.push({ score: end, member: e.key })
      } else {
        // Open-ended, or scheduled (not started) — not an active window sale.
        toRemove.push(e.key)
      }
    }

    // Free-mint index — price 0 in, priced out, unknown left untouched.
    const free = isZeroPrice(e.config.pricePerToken)
    if (free === true) {
      if (seenFree.get(e.key) !== true) toAddFree.push({ score: nowMs, member: e.key })
    } else if (free === false) {
      if (seenFree.get(e.key) !== false) toRemoveFree.push(e.key)
    }
  }

  const sweepDue = Date.now() - lastSweepAt > SWEEP_INTERVAL_MS
  if (
    toAdd.length === 0 &&
    toRemove.length === 0 &&
    toAddFree.length === 0 &&
    toRemoveFree.length === 0 &&
    !sweepDue
  ) {
    return
  }

  const pipeline = redis.multi()
  if (toAdd.length > 0) {
    pipeline.zadd(SALE_ENDS_KEY, toAdd[0], ...toAdd.slice(1))
  }
  if (toRemove.length > 0) {
    pipeline.zrem(SALE_ENDS_KEY, ...toRemove)
  }
  if (toAddFree.length > 0) {
    pipeline.zadd(SALE_FREE_KEY, toAddFree[0], ...toAddFree.slice(1))
  }
  if (toRemoveFree.length > 0) {
    pipeline.zrem(SALE_FREE_KEY, ...toRemoveFree)
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
    // Free index has no time dimension — cap cardinality by evicting the
    // lowest scores (least-recently-indexed) beyond the ceiling.
    pipeline.zremrangebyrank(SALE_FREE_KEY, 0, -MAX_FREE - 1)
  }
  await pipeline.exec()

  // Update the per-pod memory only after the write succeeded, so a failed
  // pipeline retries the adds on the next batch instead of skipping them.
  if (seenEnds.size + toAdd.length > MAX_SEEN) seenEnds.clear()
  for (const a of toAdd) seenEnds.set(a.member, a.score)
  for (const k of toRemove) seenEnds.delete(k)

  if (seenFree.size + toAddFree.length + toRemoveFree.length > MAX_SEEN) seenFree.clear()
  for (const a of toAddFree) seenFree.set(a.member, true)
  for (const k of toRemoveFree) seenFree.set(k, false)
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

/**
 * The set of currently-free moments ("collection:tokenId"). Two consumers with
 * OPPOSITE failure semantics: the Latest/Most Sales feeds EXCLUDE members (a
 * Redis failure degrades to a no-op — show everything), while the discover
 * free=1 filter INCLUDES only members (a failure degrades to an empty filtered
 * feed — its honest "no matches" state, never wrong-positives). Members only
 * (no scores), bounded by the write-side cap.
 */
export async function getFreeMoments(): Promise<Set<string>> {
  try {
    const members = (await redis.zrange(SALE_FREE_KEY, 0, -1)) as string[]
    return new Set(members)
  } catch {
    return new Set()
  }
}
