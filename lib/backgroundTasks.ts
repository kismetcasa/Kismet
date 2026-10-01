import { sweepExpiredListings } from './listings'
import { withLeaderLock } from './leaderLock'
import type { MachineJob } from './experience/machineJobs'
import { readStatsLastAttempt } from './statsHealth'
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
 *    pipeline itself: each tick it reads the pipeline's own heartbeat
 *    (lib/statsHealth — the last run that did work, a skipped run does not
 *    count) and runs it when nothing has been recorded for an hour. An
 *    external scheduler, where one exists, keeps precedence: its runs stamp
 *    the same heartbeat and this loop stands down; should the two ever
 *    overlap, the pipeline's phase locks make the second run a benign skip.
 * 3. The machines' scheduled jobs (lib/experience/machineJobs: seed
 *    commitments hourly, referral payouts daily), the other two vercel.json
 *    crons, driven the same way: each tick reads when the job last ran —
 *    the cron route records its runs too — and runs it once that is older
 *    than its interval.
 *
 * 2 and 3 are production only (cronsInProcess): never on Vercel, where the
 * crons are scheduled and a timer inside a serverless instance can be frozen
 * mid-run holding the locks; never outside production, where a laptop must
 * not rebuild the shared snapshots or pay rewards from branch code; and off
 * for the harnesses that boot the built app (CRON_INPROCESS=off).
 *
 * Multi-pod: each runs under a Redis leader lock so only one pod cluster-wide
 * executes them per tick. Without the lock, N pods × N runs each tick
 * amplifies the work linearly with replicas.
 */

const TICK_MS = 5 * 60 * 1000
const LOCK_TTL_SEC = 60

const STATS_INTERVAL_MS = 60 * 60 * 1000
const STATS_FIRST_CHECK_MS = 2 * 60 * 1000
// Serializes pods for the run; the phases hold their own locks for the
// duration of the work.
const STATS_LOCK_TTL_SEC = 15 * 60

let started = false

export function startBackgroundTasks(): void {
  if (started) return
  started = true
  // Fire once immediately so a fresh deploy doesn't wait 5 min for the
  // first sweep. Non-awaited intentionally — instrumentation.register()
  // shouldn't block on cleanup work.
  void runSweep()
  setInterval(runSweep, TICK_MS)
  if (cronsInProcess()) {
    // The first check waits until a fresh deploy has finished booting.
    const tick = () => {
      void runStatsFallback()
      for (const job of MACHINE_JOBS) void runMachineJob(job)
    }
    setTimeout(tick, STATS_FIRST_CHECK_MS)
    setInterval(tick, TICK_MS)
  }
}

function cronsInProcess(): boolean {
  if (process.env.VERCEL) return false
  if (process.env.NODE_ENV !== 'production') return false
  return process.env.CRON_INPROCESS !== 'off'
}

// One in-flight flag per task, then the leader lock: withLeaderLock returns
// null if another pod holds it — the normal "you don't run this tick" path,
// not an error. Throws from the task itself are logged, never propagated.
const inFlight = new Set<string>()
async function guarded(name: string, ttlSec: number, fn: () => Promise<unknown>): Promise<void> {
  if (inFlight.has(name)) return
  inFlight.add(name)
  try {
    await withLeaderLock(name, ttlSec, fn)
  } catch (err) {
    console.error(`[bg:${name}] failed:`, err instanceof Error ? err.message : String(err))
  } finally {
    inFlight.delete(name)
  }
}

function runSweep(): Promise<void> {
  return guarded('sweep-listings', LOCK_TTL_SEC, sweepExpiredListings)
}

async function runStatsFallback(): Promise<void> {
  // A lock-free read first: most ticks the heartbeat is fresh and nothing else
  // is needed. An UNREADABLE heartbeat skips the tick — it is not "never ran".
  let last: number | null
  try {
    last = await readStatsLastAttempt('rebuild')
  } catch {
    return
  }
  if (!isStatsRunDue(last, Date.now(), STATS_INTERVAL_MS)) return
  await guarded('stats-pipeline', STATS_LOCK_TTL_SEC, async () => {
    // Re-check under the lock: another pod may have run it since the read.
    if (!isStatsRunDue(await readStatsLastAttempt('rebuild'), Date.now(), STATS_INTERVAL_MS)) return
    console.log('[bg:stats-pipeline] no run recorded in the last hour — running the pipeline')
    await runStatsPipeline()
  })
}

const MACHINE_JOBS: MachineJob[] = ['experience-seeds', 'referral-payouts']
// Serializes pods for a run; a payout run holds its own lock as well.
const MACHINE_JOB_LOCK_TTL_SEC = 10 * 60

async function runMachineJob(job: MachineJob): Promise<void> {
  // Loaded on the first tick, not at boot: the jobs reach the chain and the
  // sponsoring account, which nothing else here needs.
  const jobs = await import('./experience/machineJobs')
  const due = async () => isStatsRunDue(await jobs.readMachineJobRun(job), Date.now(), jobs.MACHINE_JOB_INTERVAL_MS[job])
  // An unreadable record skips the tick — it is not "never ran".
  if (!(await due().catch(() => false))) return
  await guarded(job, MACHINE_JOB_LOCK_TTL_SEC, async () => {
    // Re-check under the lock: another pod may have run it since the read.
    if (!(await due())) return
    console.log(`[bg:${job}] not run within its interval — running it`)
    await (job === 'experience-seeds' ? jobs.commitMachineSeeds() : jobs.payReferralRewards())
  })
}
