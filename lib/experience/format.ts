/**
 * Display formatting for published odds. PURE — no imports — so the oracle can
 * execute every branch and so the same functions render the machine page, the
 * Capsule Studio preview and the curator's review queue.
 *
 * ── Why this is not `toFixed(1)` inline ──
 *
 * The odds table is the one surface whose entire purpose is an accurate
 * disclosure a player can act on before paying. `(p * 100).toFixed(1)` renders a
 * live 0.04% prize as "0.0%" — visually identical to an exhausted row, and a
 * statement that the piece cannot be won when it can. Rounding a non-zero
 * probability to zero is the one thing this formatter must never do, so
 * precision is chosen per magnitude and the smallest band degrades to an
 * explicit inequality rather than to a false zero.
 */

/**
 * A probability as a percentage string, with precision that scales to the
 * value. Never returns "0%" for a positive probability.
 */
export function formatProbability(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '0%'
  if (p >= 1) return '100%'
  const pct = p * 100
  if (pct >= 10) return `${pct.toFixed(1)}%`
  if (pct >= 1) return `${pct.toFixed(2)}%`
  if (pct >= 0.001) return `${pct.toFixed(3)}%`
  // Below a thousandth of a percent the digits stop being meaningful to a
  // reader; the ratio form below carries the exact figure instead.
  return '<0.001%'
}

/**
 * The same probability as "1 in N", which is how people actually reason about
 * a draw. Returned alongside the percentage rather than instead of it: the
 * percentage supports comparing rows, the ratio supports understanding one.
 *
 * Null when a ratio would say nothing — an impossible row, or a certain one
 * where "1 in 1" reads as a defect rather than a certainty.
 */
export function formatOddsRatio(p: number): string | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null
  return `1 in ${Math.round(1 / p).toLocaleString('en-US')}`
}

/** Remaining copies for a row. `null` is an open edition, which is genuinely
 *  unbounded rather than a large number, so it gets a word and not a glyph a
 *  screen reader would announce as "infinity sign". */
export function formatRemaining(remaining: number | null): string {
  if (remaining === null) return 'unlimited'
  return remaining === 1 ? '1 left' : `${remaining.toLocaleString('en-US')} left`
}

/** A short, human title for a pool entry. Falls back to the token id, which is
 *  what the row showed before metadata hydration existed and is still correct
 *  when a metadata host is unreachable. */
export function artworkTitle(name: string | null | undefined, tokenId: string): string {
  const trimmed = name?.trim()
  return trimmed ? trimmed : `#${tokenId}`
}
