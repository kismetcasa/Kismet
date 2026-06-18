// Pure earnings helpers — NO server imports, so client components (the profile
// toggle) can use them without dragging redis / rpc into the browser bundle.
// lib/stats.ts re-exports EarningsMetric for server callers.

export type EarningsMetric = 'eth' | 'usdc' | 'usd'

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
  if (denom === 'eth') return `${trimNum(e.eth, 4)} ETH`
  if (denom === 'usdc') return `${trimNum(e.usdc, 2)} USDC`
  return `$${trimNum(e.usd, 2)}`
}
