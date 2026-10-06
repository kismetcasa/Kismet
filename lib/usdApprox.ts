import { formatEther } from 'viem'

/** "$1,234.56" for a US-dollar estimate: two decimals with en-US grouping, as
 *  the platform's other USD figures; a sub-cent amount reads "< $0.01" rather
 *  than a misleading "$0.00". Callers put the "≈" in front. */
export function formatUsdApprox(usd: number): string {
  if (usd < 0.01) return '< $0.01'
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** "≈ $25.10" for an ETH amount in wei at the live rate (useEthUsd), or null
 *  when there is no rate — the feed down or stale, where a wrong number is
 *  worse than none — or nothing to price. */
export function ethUsdApprox(wei: bigint | string, ethUsd: number | null): string | null {
  if (ethUsd === null) return null
  let amount: bigint
  try {
    amount = BigInt(wei)
  } catch {
    return null
  }
  if (amount <= 0n) return null
  return `≈ ${formatUsdApprox(Number(formatEther(amount)) * ethUsd)}`
}
