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
 *  Uses UTC-anchored parsing so DST / local offset can never slip a day.
 *  Degrades (returns the input unchanged) rather than throwing on an
 *  unparseable input, so one corrupt series entry can't crash the caller —
 *  `new Date('9999-99-99…').toISOString()` would otherwise throw RangeError. */
export function shiftDateUtc(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** True for a well-formed 'YYYY-MM-DD' SHAPE (not calendar validity). */
export function isIsoDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** Shape AND real-calendar validity. isIsoDay is shape-only, so '2026-02-30'
 *  or '9999-99-99' pass it; here a UTC round-trip rejects rolled-over / NaN
 *  dates. getDailyStats gates on THIS so a corrupt or hand-edited hash field
 *  can't become the (lexicographically latest) point that shiftDateUtc would
 *  then choke on when computing a window cutoff. */
export function isValidIsoDay(s: unknown): s is string {
  if (!isIsoDay(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
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
  return windowed
    .map((p) => {
      const eth =
        metric === 'volume' ? p.volumeEth : metric === 'artist' ? p.artistEth : p.platformEth
      const usdc =
        metric === 'volume' ? p.volumeUsdc : metric === 'artist' ? p.artistUsdc : p.platformUsdc
      // USD needs a price to value the (dominant) eth leg. An unpriced day
      // (ethUsd 0) would crater the CUMULATIVE line to the usdc leg — a false
      // canyon that squashes the axis and can explode the % delta — so DROP it
      // from USD (mirroring the endpoint hiding the figure). ETH keeps every day:
      // its eth leg is always honest, the usdc leg just isn't converted.
      if (denom === 'usd') {
        return p.ethUsd > 0 ? { date: p.date, value: eth * p.ethUsd + usdc } : null
      }
      return { date: p.date, value: eth + (p.ethUsd > 0 ? usdc / p.ethUsd : 0) }
    })
    .filter((p): p is { date: string; value: number } => p !== null)
}

/**
 * Build the SVG line + area `d` strings for a sparkline, in a `w`×`h` viewBox
 * with `pad` vertical breathing room. Pure so the render math (finiteness, the
 * flat case) is unit-tested rather than inline in the component. Returns null
 * for < 2 points. A FLAT series (all equal — e.g. a metric still at 0) pins to
 * the BASELINE, avoiding both a /0 NaN and the "floating mid-height" misread.
 * Inputs are finite (windowTrendSeries guarantees it), so output is never NaN.
 */
export function buildSparkline(
  values: number[],
  w: number,
  h: number,
  pad: number,
): { line: string; area: string } | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const flat = min === max
  const x = (i: number) => (i / (values.length - 1)) * w
  const y = (v: number) => (flat ? h - pad : pad + (1 - (v - min) / (max - min)) * (h - pad * 2))
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ')
  const area = `${line} L ${w.toFixed(2)} ${h} L 0 ${h} Z`
  return { line, area }
}
