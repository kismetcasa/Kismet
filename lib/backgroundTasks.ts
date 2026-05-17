import { redis, TRENDING_KEY } from './redis'
import { sweepExpiredListings } from './listings'
import { KEY_PROFILES } from './profile'

/**
 * Periodic Redis cleanup tasks. Per-task try/catch isolates failures;
 * running guard prevents overlapping ticks.
 *
 * Multi-pod: each pod runs this independently. All tasks are idempotent
 * (SET NX claim keys; deterministic ZREMRANGEBY*) so duplicate work is
 * harmless. If pod count grows, wrap runSweep in a SET NX pod-lock.
 */

const TICK_MS = 5 * 60 * 1000
const NOTIF_TTL_SECONDS = 60 * 24 * 60 * 60   // 60 days
const TRENDING_KEEP_TOP = 10_000

let started = false
let running = false

export function startBackgroundTasks(): void {
  if (started) return
  started = true
  // Fire once immediately so a fresh deploy doesn't wait 5 min for the
  // first sweep. Non-awaited intentionally — instrumentation.register()
  // shouldn't block on cleanup work.
  void runSweep()
  setInterval(runSweep, TICK_MS)
}

async function runSweep(): Promise<void> {
  if (running) return
  running = true
  try {
    await Promise.all([
      runTask('sweep-listings', sweepExpiredListings),
      runTask('trim-notifications', trimNotifications),
      runTask('trim-trending', trimTrending),
    ])
  } finally {
    running = false
  }
}

async function runTask(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    console.error(`[bg:${name}] failed:`, err instanceof Error ? err.message : String(err))
  }
}

// Drop notifications older than NOTIF_TTL_SECONDS. Without this the
// per-user zset only shrank via the MAX_PER_USER=200 trim on write —
// low-activity users accumulated old entries indefinitely.
async function trimNotifications(): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - NOTIF_TTL_SECONDS
  const profiles = (await redis.smembers(KEY_PROFILES)) as string[]
  await Promise.all(
    profiles.map((addr) =>
      redis.zremrangebyscore(`kismetart:notif:${addr.toLowerCase()}`, 0, cutoff).catch(() => 0),
    ),
  )
}

// Keep the trending zset capped at top TRENDING_KEEP_TOP entries —
// /api/timeline reads only that many, so anything past is dead weight.
async function trimTrending(): Promise<void> {
  // Range [0, -KEEP-1] removes every rank except the top KEEP.
  await redis.zremrangebyrank(TRENDING_KEY, 0, -TRENDING_KEEP_TOP - 1)
}
