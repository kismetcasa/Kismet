import { sweepExpiredListings } from './listings'
import { withLeaderLock } from './leaderLock'

/**
 * Periodic Redis cleanup. Reduced to the listings sweep — notification
 * cleanup moved to lazy-on-read in loadAndAnnotate, trending cleanup
 * moved to inline-on-write in /api/collect. The listings sweep stays
 * periodic because it touches per-listing keys + has to fire expiry
 * notifications, which is awkward to do lazy.
 *
 * Multi-pod: the sweep runs under a Redis leader lock so only one pod
 * cluster-wide executes it per tick. Without the lock, N pods × N sweeps
 * each tick amplifies the work linearly with replicas.
 */

const TICK_MS = 5 * 60 * 1000
const LOCK_TTL_SEC = 60

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
