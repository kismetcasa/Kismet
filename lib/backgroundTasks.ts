import { sweepExpiredListings } from './listings'
import { withLeaderLock } from './leaderLock'
import { getStatsHealth } from './statsHealth'
import { isStatsRunDue } from './statsMath'
import { runStatsPipeline } from './statsPipeline'

/**
 * Periodic work that only a long-running Node process can carry.
 *
 * 1. Redis cleanup, reduced to the listings sweep — notification cleanup
 *    moved to lazy-on-read in loadAndAnnotate, trending cleanup moved to
 *    inline-on-write in /api/collect. The listings sweep stays periodic
 *    because it touches per-listing keys + has to fire expiry notifications,
 *    which is awkward to do lazy.
 * 2. The hourly stats pipeline (lib/statsPipeline: stats rebuild → catalog
 *    census → sweep index → credit reconcile). vercel.json schedules
 *    /api/cron/sync-stats on Vercel ONLY; on a persistent host nothing calls
 *    it unless an external scheduler is configured, so the app drives the
 *    pipeline itself: each tick, the leader reads the pipeline's own
 *    heartbeat (lib/statsHealth) and runs it when no run — external or
 *    in-process — has been recorded for an hour. An external scheduler, where
 *    one exists, keeps precedence: its runs stamp the same heartbeat and this
 *    loop stands down; should the two ever overlap, the pipeline's phase
 *    locks make the second run a benign skip. The first check waits until a
 *    fresh deploy has finished booting.
 *
 * Multi-pod: both run under a Redis leader lock so only one pod cluster-wide
 * executes them per tick. Without the lock, N pods × N runs each tick
 * amplifies the work linearly with replicas.
 */

const TICK_MS = 5 * 60 * 1000
const LOCK_TTL_SEC = 60

const STATS_INTERVAL_MS = 60 * 60 * 1000
const STATS_FIRST_CHECK_MS = 2 * 60 * 1000
// Serializes pods for the check and the run it starts; the phases hold their
// own locks for the duration of the work.
const STATS_LOCK_TTL_SEC = 15 * 60

let started = false
let running = false
let statsRunning = false

export function startBackgroundTasks(): void {
  if (started) return
  started = true
  // Fire once immediately so a fresh deploy doesn't wait 5 min for the
  // first sweep. Non-awaited intentionally — instrumentation.register()
  // shouldn't block on cleanup work.
  void runSweep()
  setInterval(runSweep, TICK_MS)
  setTimeout(runStatsFallback, STATS_FIRST_CHECK_MS)
  setInterval(runStatsFallback, TICK_MS)
}

async function runSweep(): Promise<void> {
  if (running) return
  running = true
  try {
    // withLeaderLock returns null if another pod holds the lock — that's
    // the normal "you don't run this tick" path, not an error. Throws
    // from sweepExpiredListings itself propagate and are logged below.
    await withLeaderLock('sweep-listings', LOCK_TTL_SEC, sweepExpiredListings)
  } catch (err) {
    console.error('[bg:sweep-listings] failed:', err instanceof Error ? err.message : String(err))
  } finally {
    running = false
  }
}

async function runStatsFallback(): Promise<void> {
  if (statsRunning) return
  statsRunning = true
  try {
    await withLeaderLock('stats-pipeline', STATS_LOCK_TTL_SEC, async () => {
      const health = await getStatsHealth()
      if (!isStatsRunDue(health.rebuild?.lastRunAt, Date.now(), STATS_INTERVAL_MS)) return
      console.log('[bg:stats-pipeline] no run recorded in the last hour — running the pipeline')
      await runStatsPipeline()
    })
  } catch (err) {
    console.error('[bg:stats-pipeline] failed:', err instanceof Error ? err.message : String(err))
  } finally {
    statsRunning = false
  }
}
