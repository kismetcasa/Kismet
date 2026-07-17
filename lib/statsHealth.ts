import { redis } from './redis'

// Heartbeat for the hourly stats pipeline (rebuild + catalog census). The
// pipeline's integrity guards ABORT on an anomaly (implausible shrink,
// value-jump/unit-drift, scope collapse, unreadable collection) and preserve
// the last good snapshot — the safe behavior — but the only prior signal was a
// console.error nobody watches. So a wedged rebuild (e.g. the value-jump guard
// tripping every run until a human DELs the baseline) could serve hours-stale
// totals with no trace. This records each run's outcome per phase so
// /api/admin/stats-health can surface "last success age + last error" and an
// external monitor can alert. Best-effort: recording never throws and never
// blocks the run it measures.

export type StatsPhase = 'rebuild' | 'census'
export type StatsRunStatus = 'ok' | 'error' | 'skipped'

export interface StatsPhaseHealth {
  /** Epoch ms of the last run attempt of this phase (any outcome). */
  lastRunAt: number
  /** Epoch ms of the last SUCCESSFUL run; carried forward across failures so
   *  "how long since this last worked" stays answerable. */
  lastOkAt?: number
  /** Message of the last failure, cleared on the next success. */
  lastError?: string
  /** Epoch ms of the last failure. */
  lastErrorAt?: number
}

// Hourly cron: no TTL — the record persists until the next run overwrites it,
// so a phase that stops running entirely keeps its last-known state (and grows
// stale, which the reader flags) rather than vanishing.
const healthKey = (phase: StatsPhase) => `kismetart:stats:health:${phase}`

// No success in longer than this = at least two missed hourly runs → unhealthy.
export const STATS_STALE_MS = 3 * 60 * 60 * 1000

/**
 * Record a phase's run outcome. `ok` stamps success and CLEARS any prior error;
 * `error` records the (bounded) message while PRESERVING lastOkAt so
 * age-since-success stays meaningful; `skipped` (single-flight lock held) only
 * bumps lastRunAt and touches nothing else — a benign no-op, neither success
 * nor failure. Read-modify-write is fine on an hourly cadence. Never throws.
 */
export async function recordStatsRun(
  phase: StatsPhase,
  status: StatsRunStatus,
  error?: string,
): Promise<void> {
  try {
    const key = healthKey(phase)
    const now = Date.now()
    // `ok` is a full write needing no prior state — stamp both fields and clear
    // any error by omission.
    if (status === 'ok') {
      await redis.set(key, { lastRunAt: now, lastOkAt: now } satisfies StatsPhaseHealth)
      return
    }
    // `skipped`/`error` are read-modify-write: they PRESERVE lastOkAt, and
    // `skipped` preserves a prior lastError. A FAILED prev-read must NOT fall
    // through to a stripped overwrite — that would erase lastError and flip
    // `healthy` back to true while the pipeline is still broken, silencing the
    // alert this exists to raise (and Redis is likeliest to be flaky exactly
    // when errors are recorded). So distinguish a read FAILURE (bail, preserve
    // the record) from a genuine ABSENT key (null → proceed, nothing to lose).
    let prev: StatsPhaseHealth | null
    try {
      prev = await redis.get<StatsPhaseHealth>(key)
    } catch {
      return
    }
    if (status === 'skipped') {
      await redis.set(key, { ...(prev ?? {}), lastRunAt: now } satisfies StatsPhaseHealth)
      return
    }
    await redis.set(key, {
      lastRunAt: now,
      lastOkAt: prev?.lastOkAt,
      lastError: (error ?? 'unknown error').slice(0, 300),
      lastErrorAt: now,
    } satisfies StatsPhaseHealth)
  } catch {
    // Instrumentation must never break the run it measures.
  }
}

/** Persisted health for both phases (null when a phase has never recorded). */
export async function getStatsHealth(): Promise<Record<StatsPhase, StatsPhaseHealth | null>> {
  const read = async (phase: StatsPhase): Promise<StatsPhaseHealth | null> => {
    try {
      const raw = await redis.get<StatsPhaseHealth | string | null>(healthKey(phase))
      if (!raw) return null
      const parsed = typeof raw === 'string' ? (JSON.parse(raw) as StatsPhaseHealth) : raw
      return typeof parsed?.lastRunAt === 'number' ? parsed : null
    } catch {
      return null
    }
  }
  const [rebuild, census] = await Promise.all([read('rebuild'), read('census')])
  return { rebuild, census }
}
