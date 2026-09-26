import type { Address, PublicClient } from 'viem'
import { walkError } from './toast'
import { MULTICALL3_ADDRESS } from './zoraMint'
import { sweepBundle, sweepSimulationArgs, type SweepCall } from './sweepBatch'

// Pre-flight for the sweep bundle (SWEEP_IMPLEMENTATION.md §4.3–4.4): the
// network half over lib/sweepBatch's pure builders. Both reads are eth_call
// shaped — nothing is broadcast — so a failure here costs the user nothing.

export type SweepSimulation = { ok: boolean[] } | { error: 'insufficient-funds' | 'rpc' }

/**
 * Simulate the bundle with allowFailure=true on every sub-call and report each
 * slot's success. An `insufficient-funds` error is the node refusing the call
 * because `account` cannot cover `value` (op-geth checks the balance even for
 * eth_call), which is why the hook trims to the balance BEFORE simulating.
 */
export async function simulateSweep(
  client: PublicClient,
  account: Address,
  calls: readonly SweepCall[],
): Promise<SweepSimulation> {
  if (calls.length === 0) return { ok: [] }
  try {
    const sim = sweepSimulationArgs(calls)
    const { result } = await client.simulateContract({
      address: MULTICALL3_ADDRESS,
      abi: sim.abi,
      functionName: sim.functionName,
      args: sim.args,
      value: sim.value,
      account,
    })
    return { ok: result.map((r) => r.success) }
  } catch (err) {
    return { error: isInsufficientFunds(err) ? 'insufficient-funds' : 'rpc' }
  }
}

function isInsufficientFunds(err: unknown): boolean {
  return walkError(
    err,
    (e) =>
      e.name === 'InsufficientFundsError' ||
      (typeof e.message === 'string' && /insufficient funds/i.test(e.message)),
  )
}

/**
 * Gas cost of the STRICT bundle in wei (gas × maxFeePerGas), or null when the
 * estimate is unavailable — the caller then keeps the constant headroom.
 * Estimated on the strict bundle because that is what gets signed; a smaller
 * prefix of it costs less, so one estimate upper-bounds every trim of it.
 */
export async function estimateSweepGasCost(
  client: PublicClient,
  account: Address,
  calls: readonly SweepCall[],
): Promise<bigint | null> {
  if (calls.length === 0) return 0n
  try {
    const bundle = sweepBundle(calls)
    const [gas, fees] = await Promise.all([
      client.estimateContractGas({
        address: MULTICALL3_ADDRESS,
        abi: bundle.abi,
        functionName: bundle.functionName,
        args: bundle.args,
        value: bundle.value,
        account,
      }),
      client.estimateFeesPerGas(),
    ])
    return gas * fees.maxFeePerGas
  } catch {
    return null
  }
}
