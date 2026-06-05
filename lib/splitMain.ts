import { parseAbi, type Address } from 'viem'
import { getChain } from './chains'
import type { SplitRecipient } from './splits'

/**
 * 0xSplits v1 `SplitMain` — the singleton router for creating and distributing
 * splits, deterministically deployed at the same address on every chain
 * (see `SPLIT_MAIN_V1` in lib/chains.ts).
 *
 * Scope: this module is used ONLY on user-paid chains (mainnet). There, WE
 * create the split client-side at mint time and distribute it client-side, so
 * we own its exact parameters. Base splits are created + distributed by the
 * In Process relay and never touch this module — keep it that way so the Base
 * money path has a single owner.
 *
 * SplitMain stores only a hash of (accounts, percentAllocations, distributorFee)
 * and reverts on any mismatch, so create and distribute MUST pass byte-identical
 * arrays. `reconstructSplitParams` is the single source of truth both go through.
 */
export const SPLIT_MAIN_ABI = parseAbi([
  'function createSplit(address[] accounts, uint32[] percentAllocations, uint32 distributorFee, address controller) returns (address)',
  'function predictImmutableSplitAddress(address[] accounts, uint32[] percentAllocations, uint32 distributorFee) view returns (address)',
  'function distributeETH(address split, address[] accounts, uint32[] percentAllocations, uint32 distributorFee, address distributorAddress)',
  'function distributeERC20(address split, address token, address[] accounts, uint32[] percentAllocations, uint32 distributorFee, address distributorAddress)',
])

// 0xSplits PERCENTAGE_SCALE — allocations are expressed in millionths (1e6).
const PERCENTAGE_SCALE = 1_000_000

/**
 * We create fee-less splits (matching In Process's behavior), so allocations
 * stay an exact `pct × 10_000` and distribute never needs a stored fee.
 */
export const DISTRIBUTOR_FEE = 0

/** Per-chain SplitMain address (from the chain registry). */
export function splitMainAddress(chainId: number): Address {
  return getChain(chainId).splitMain
}

/**
 * Rebuild the exact on-chain SplitMain parameters from our stored recipient
 * list. Both createSplit (mint) and distribute go through this helper, so the
 * arrays are guaranteed identical and the on-chain hash check passes:
 *   - `accounts`: addresses sorted ascending (SplitMain's required ordering)
 *   - `percentAllocations`: each whole-number pct × 10_000
 *
 * Because `validateSplitsArray` guarantees integer percentages summing to 100,
 * `pct × 10_000` sums to exactly 1e6 with no remainder. Throws if it doesn't —
 * a corrupt list must never reach the contract (it would revert and cost the
 * user gas).
 */
export function reconstructSplitParams(recipients: SplitRecipient[]): {
  accounts: Address[]
  percentAllocations: number[]
} {
  const sorted = [...recipients].sort((a, b) =>
    a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
  )
  const accounts = sorted.map((r) => r.address.toLowerCase() as Address)
  const percentAllocations = sorted.map((r) => r.percentAllocation * 10_000)
  const sum = percentAllocations.reduce((a, b) => a + b, 0)
  if (sum !== PERCENTAGE_SCALE) {
    throw new Error(`split allocations must sum to 100% (got ${sum / 10_000}%)`)
  }
  return { accounts, percentAllocations }
}
