import { redis } from './redis'

// Global concurrency governor for distribute-all. Each invocation fans out up
// to DISTRIBUTE_ALL_CAP sponsored on-chain txs through the ONE shared inprocess
// relay wallet (a platform SPOF, also carrying every mint/collect). Without a
// platform-wide cap, N artists clicking at once = N × CAP simultaneous relay
// submissions — enough to back up the relay's single nonce sequence and starve
// mints, and to pile long-running fan-outs onto the single box. This bounds the
// number of distribute-all runs IN FLIGHT platform-wide; excess callers get a
// 429 "try again shortly" (a graceful degrade, not a crash).
//
// Implemented as an INCR/DECR counter, not a precise semaphore — for a
// protective throttle, approximate is fine, and the TTL (refreshed on each
// acquire) means a crashed run that never released can't wedge the gate: after
// GOVERNOR_TTL_S of no activity the counter decays. Never throws — a Redis
// failure fails OPEN (allow), since the per-user quota + per-invocation cap are
// independent backstops and blocking all distribution on a Redis blip is worse.

const GOVERNOR_KEY = 'kismetart:distribute:inflight'
const GOVERNOR_MAX = 20
const GOVERNOR_TTL_S = 180

/** Try to take an in-flight slot. Returns true if acquired (caller MUST later
 *  releaseDistributeSlot), false if the platform-wide cap is reached. */
export async function acquireDistributeSlot(): Promise<boolean> {
  try {
    const n = await redis.incr(GOVERNOR_KEY)
    // Refresh the safety TTL on every acquire so a leaked slot (missed release
    // after a crash) can't pin the counter high forever.
    await redis.expire(GOVERNOR_KEY, GOVERNOR_TTL_S).catch(() => {})
    if (n > GOVERNOR_MAX) {
      // Over cap — give the slot back and reject.
      await redis.decr(GOVERNOR_KEY).catch(() => {})
      return false
    }
    return true
  } catch {
    return true // fail open — quota + cap still bound the work
  }
}

/** Release a slot taken by acquireDistributeSlot. Floors at 0 so an extra
 *  release (or a TTL-expired counter) can't drive it negative and inflate
 *  future capacity. Best-effort. */
export async function releaseDistributeSlot(): Promise<void> {
  try {
    const n = await redis.decr(GOVERNOR_KEY)
    if (n < 0) await redis.set(GOVERNOR_KEY, 0).catch(() => {})
  } catch {
    // Non-fatal: the TTL decays a stuck counter on its own.
  }
}
