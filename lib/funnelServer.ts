import { redis } from './redis'
import { FUNNEL_EVENTS, type FunnelEvent } from './funnel'

// Server-side read for the funnel counters the /api/funnel sink day-buckets
// (kismetart:funnel:<event>:<YYYY-MM-DD>, 90-day TTL). Split from lib/funnel.ts
// because that file ships in client bundles and must not import redis — the
// same client/server split earningsFormat vs stats uses.

export interface FunnelCounts {
  /** Oldest UTC day in the window (inclusive; window ends today). */
  since: string
  days: number
  /** Per-event totals over the window. */
  totals: Record<FunnelEvent, number>
  /** Per-day rows, oldest first. Zero-days are included so a gap reads as
   *  "no traffic that day", not as a hole in the data. */
  byDay: ({ date: string } & Record<FunnelEvent, number>)[]
}

/**
 * Last-`days` funnel counts in ONE MGET (events × days keys — 98 for the
 * default fortnight). Day boundaries are UTC, matching the sink's bucketing.
 * Returns null on a Redis failure so the caller can omit the block entirely
 * rather than serve zeros that would read as "no traffic".
 */
export async function getFunnelCounts(days = 14): Promise<FunnelCounts | null> {
  const dates: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    dates.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  }
  const keys = dates.flatMap((d) => FUNNEL_EVENTS.map((e) => `kismetart:funnel:${e}:${d}`))
  try {
    const raw = await redis.mget<(number | string | null)[]>(...keys)
    const totals = Object.fromEntries(
      FUNNEL_EVENTS.map((e) => [e, 0]),
    ) as Record<FunnelEvent, number>
    const byDay = dates.map((date, di) => {
      const row = { date } as { date: string } & Record<FunnelEvent, number>
      FUNNEL_EVENTS.forEach((e, ei) => {
        const n = Number(raw[di * FUNNEL_EVENTS.length + ei] ?? 0)
        row[e] = Number.isFinite(n) && n > 0 ? n : 0
        totals[e] += row[e]
      })
      return row
    })
    return { since: dates[0], days, totals, byDay }
  } catch {
    return null
  }
}
