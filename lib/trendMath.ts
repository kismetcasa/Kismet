// Pure trend-series math — shared by the server reader (getDailyStats), the
// /api/stats/trend route, the StatsModal chart, and verify-stats. Import-free
// and dependency-free on purpose: the chart is a client component, so this must
// bundle WITHOUT dragging in the server-only statsMath accumulator, and the
// verifier must run it under `node --strip-types` with no alias resolution.
//
// The recorder (lib/stats.ts recordDailyStats) writes ONE point per UTC day
// holding the all-time CUMULATIVE totals as of that day, in native eth+usdc
// plus the day's ethUsd. So plotting a point's value directly gives the
// cumulative line the user picked; the range toggle only zooms the X window.

/** One day's stored cumulative point (native units + that day's price). */
export interface DailyStatPoint {
  /** UTC calendar day, 'YYYY-MM-DD'. */
  date: string
  volumeEth: number
  volumeUsdc: number
  artistEth: number
  artistUsdc: number
  platformEth: number
  platformUsdc: number
  /** Chainlink ETH/USD at record time; 0 when the price was unavailable. */
  ethUsd: number
}

export type TrendMetric = 'volume' | 'artist' | 'platform'
export type TrendDenom = 'usd' | 'eth'
export type TrendRange = '7d' | '30d' | '90d' | 'all'

/** Trailing-window sizes in DAYS; `all` keeps the full history. */
const RANGE_DAYS: Record<TrendRange, number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
}

/** Shift a 'YYYY-MM-DD' UTC day by whole days, returning the same format.
 *  Uses UTC-anchored parsing so DST / local offset can never slip a day. */
export function shiftDateUtc(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** True for a well-formed 'YYYY-MM-DD'. */
export function isIsoDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/**
 * Window a cumulative daily series for ONE metric in ONE denomination.
 *
 * The window is measured from the series' OWN latest point (not "now"), so an
 * hour-stale or a backfilled series still shows a full, correctly-sized window
 * and the result is deterministic for tests. `days` points inclusive: the
 * cutoff is (latest − (days − 1)), so '7d' yields the 7 most recent calendar
 * days present.
 *
 * Denomination is honest-historical: USD values each day at ITS OWN recorded
 * price (never today's), and ETH shows the ETH-equivalent at that day's price
 * (the usdc leg divided by the day's ethUsd, or dropped when the price was
 * unavailable — the eth leg always passes through). Mirrors the /api/stats
 * usdOf / toEth conventions so the chart agrees with the headline it sits under.
 */
export function windowTrendSeries(
  series: DailyStatPoint[],
  metric: TrendMetric,
  denom: TrendDenom,
  range: TrendRange,
): Array<{ date: string; value: number }> {
  if (!series.length) return []
  // Defensive ascending sort — callers pass sorted, but never trust it.
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const days = RANGE_DAYS[range]
  let windowed = sorted
  if (days != null) {
    const latest = sorted[sorted.length - 1].date
    const cutoff = shiftDateUtc(latest, -(days - 1))
    windowed = sorted.filter((p) => p.date >= cutoff)
  }
  return windowed.map((p) => {
    const eth =
      metric === 'volume' ? p.volumeEth : metric === 'artist' ? p.artistEth : p.platformEth
    const usdc =
      metric === 'volume' ? p.volumeUsdc : metric === 'artist' ? p.artistUsdc : p.platformUsdc
    const value =
      denom === 'usd'
        ? eth * p.ethUsd + usdc
        : eth + (p.ethUsd > 0 ? usdc / p.ethUsd : 0)
    return { date: p.date, value }
  })
}
