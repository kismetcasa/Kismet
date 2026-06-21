// Pure earnings helpers — NO server imports, so client components (the profile
// toggle) can use them without dragging redis / rpc into the browser bundle.
// lib/stats.ts re-exports EarningsMetric for server callers.

export type EarningsMetric = 'eth' | 'usdc' | 'usd'

// Display precision per denomination — the SINGLE source for both the rendered
// string and the "is this non-zero at display precision?" test, so the two can't
// drift (a figure that renders as "$0.01" must also pass rendersNonZero).
const FRACTION_DIGITS: Record<EarningsMetric, number> = { eth: 4, usdc: 2, usd: 2 }

const valueFor = (denom: EarningsMetric, e: { eth: number; usdc: number; usd: number }) =>
  denom === 'eth' ? e.eth : denom === 'usdc' ? e.usdc : e.usd

const trimNum = (n: number, max: number) =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { maximumFractionDigits: max })

/**
 * Format an earnings figure for a denomination. The unit is baked into the
 * string, so the value is self-labeling (e.g. "3.4 ETH", "1,200 USDC",
 * "$1,240") — USDC shows the token unit, USD the dollar sign, so the two
 * dollar-denominated views never read ambiguously.
 */
export function formatEarningsValue(
  denom: EarningsMetric,
  e: { eth: number; usdc: number; usd: number },
): string {
  const v = trimNum(valueFor(denom, e), FRACTION_DIGITS[denom])
  if (denom === 'eth') return `${v} ETH`
  if (denom === 'usdc') return `${v} USDC`
  return `$${v}`
}

/**
 * True when the figure rounds to a non-zero string at the denomination's display
 * precision — i.e. formatEarningsValue won't render it as "$0" / "0 ETH". Lets a
 * caller hide sub-display dust (e.g. a 1-base-unit pending share) instead of
 * surfacing a misleading zero. Derived from FRACTION_DIGITS so it stays in
 * lockstep with what formatEarningsValue actually renders.
 */
export function rendersNonZero(
  denom: EarningsMetric,
  e: { eth: number; usdc: number; usd: number },
): boolean {
  return valueFor(denom, e) >= 0.5 * 10 ** -FRACTION_DIGITS[denom]
}
