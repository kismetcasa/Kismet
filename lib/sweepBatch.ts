import { encodeFunctionData, parseAbi, parseEventLogs, type Address, type Hex, type Log, type RpcLog } from 'viem'
import { DEFAULT_COLLECT_COMMENT } from './inprocess'
import { buildEthMintCall, buildMulticall3Batch } from './zoraMint'

// Sweep basket → transaction, the pure half (SWEEP_IMPLEMENTATION.md §4.2–4.4).
// hooks/useSweep.ts is the only caller; scripts/verify-sweep.ts decodes every
// call this module builds back to its arguments. Nothing here touches the
// network, so the treasury-critical invariants (every mint goes through
// buildEthMintCall; the signed bundle is strict) are pinned without an RPC.

export interface SweepBasketItem {
  address: Address
  tokenId: bigint
  /** Live FixedPriceSaleStrategy price, wei (re-read at click time). */
  priceWei: bigint
  /** The collection's live mintFee(), wei. */
  feeWei: bigint
}

export interface SweepCall {
  to: Address
  data: Hex
  value: bigint
}

/**
 * ETH kept back from the wallet's balance before the basket is sized, so the
 * signed bundle still has gas. 0.0005 ETH covers a 20-mint Multicall3 bundle
 * on Base with a wide margin (execution gas at Base fee levels is a small
 * fraction of this; the L1 data fee for ~6 KB of calldata is smaller still).
 * The hook refines it with a real estimate once the basket is final.
 */
export const SWEEP_GAS_HEADROOM_WEI = 500_000_000_000_000n

/**
 * One `1155.mint` sub-call per basket item, each carrying its own value
 * (price + protocol fee) — the shape FixedPriceSaleStrategy's strict equality
 * check demands per call. Every call is built by buildEthMintCall, the single
 * source of the referral and strategy arguments.
 */
export function buildSweepCalls(
  items: readonly SweepBasketItem[],
  mintTo: Address,
  comment: string = DEFAULT_COLLECT_COMMENT,
): SweepCall[] {
  return items.map((it) => {
    const { abi, functionName, args, value } = buildEthMintCall({
      tokenId: it.tokenId,
      mintTo,
      quantity: 1n,
      mintFee: it.feeWei,
      pricePerToken: it.priceWei,
      comment,
    })
    return { to: it.address, data: encodeFunctionData({ abi, functionName, args }), value }
  })
}

/**
 * The bundle the user SIGNS: Multicall3 aggregate3Value with allowFailure=false
 * on every sub-call, so one revert undoes the whole batch and nobody is
 * partially charged. Never loosen this — a value-carrying sub-call that fails
 * under allowFailure=true leaves its ETH stranded in Multicall3 (SWEEP_IMPLEMENTATION.md §4.3).
 */
export function sweepBundle(calls: readonly SweepCall[]) {
  return buildMulticall3Batch(calls)
}

/**
 * The bundle the client SIMULATES (eth_call only — nothing is sent, so nothing
 * can strand): the same calls with allowFailure=true, so a would-revert
 * sub-call reports `success: false` in its slot instead of failing the whole
 * simulation. Derived from the strict bundle so the two can never disagree on
 * targets, calldata or values.
 */
export function sweepSimulationArgs(calls: readonly SweepCall[]) {
  const strict = buildMulticall3Batch(calls)
  return {
    abi: strict.abi,
    functionName: strict.functionName,
    args: [strict.args[0].map((c) => ({ ...c, allowFailure: true }))] as const,
    value: strict.value,
  } as const
}

/**
 * Longest cheapest-first PREFIX whose outlay sum fits `budgetWei`. Because the
 * basket is ranked ascending, a prefix is the best-value subset a budget can
 * buy, and dropping from the tail never invalidates an earlier sub-call.
 */
export function trimToBudget<T extends { outlayWei: bigint }>(
  items: readonly T[],
  budgetWei: bigint,
): { kept: T[]; dropped: T[] } {
  const kept: T[] = []
  let sum = 0n
  let i = 0
  for (; i < items.length; i++) {
    const next = sum + items[i].outlayWei
    if (next > budgetWei) break
    sum = next
    kept.push(items[i])
  }
  return { kept, dropped: items.slice(i) }
}

/**
 * Map simulation results back to items by position. A length mismatch means
 * the results cannot be attributed, so everything is dropped (fail-closed:
 * an unattributed row must never reach the signed bundle).
 */
export function applySimulation<T>(items: readonly T[], ok: readonly boolean[]): { kept: T[]; dropped: T[] } {
  if (ok.length !== items.length) return { kept: [], dropped: [...items] }
  const kept: T[] = []
  const dropped: T[] = []
  items.forEach((it, i) => {
    if (ok[i]) kept.push(it)
    else dropped.push(it)
  })
  return { kept, dropped }
}

const TRANSFER_SINGLE_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * How many of `items` a receipt actually minted to `account`: one
 * TransferSingle(0x0 → account, id) emitted by the item's own collection, each
 * counted once. This is the client's success test — a wallet can replace a
 * pending transaction (a speed-up carries the same mints under a new hash; a
 * cancel mints nothing), so `receipt.status` alone is not proof. It is the
 * same log /api/collect verifies server-side.
 */
export function countSweepMints(logs: readonly (Log | RpcLog)[], items: readonly SweepBasketItem[], account: Address): number {
  const wanted = new Set(items.map((it) => `${it.address.toLowerCase()}:${it.tokenId}`))
  const seen = new Set<string>()
  for (const log of parseEventLogs({ abi: TRANSFER_SINGLE_ABI, eventName: 'TransferSingle', logs: [...logs] })) {
    const { from, to, id } = log.args
    if (from.toLowerCase() !== ZERO_ADDRESS || to.toLowerCase() !== account.toLowerCase()) continue
    const key = `${log.address.toLowerCase()}:${id}`
    if (wanted.has(key)) seen.add(key)
  }
  return seen.size
}
