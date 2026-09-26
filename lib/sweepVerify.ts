import type { Address, PublicClient } from 'viem'
import { isAddress, isValidTokenId } from './address'
import { fetchEligibleTokensMulti, readMintFeesWithBound } from './saleConfig'
import { rankSweepCandidates } from './sweepRank'
import { sweepKey, type SweepResponseItem } from './sweepIndexCore'
import {
  SWEEP_GAS_HEADROOM_WEI,
  applySimulation,
  buildSweepCalls,
  trimToBudget,
  type SweepBasketItem,
} from './sweepBatch'
import { estimateSweepGasCost, simulateSweep } from './sweepSimulate'

// The sweep's click-time verification (SWEEP_IMPLEMENTATION.md §4.1–4.4),
// kept out of the React hook so scripts/verify-sweep.ts can drive it end to
// end on a fake chain: a pool page in, a sized basket out, with every
// decision re-derived from on-chain reads made HERE — never from the index's
// numbers. hooks/useSweep.ts is the only production caller.

export type SweepRowState =
  | 'pending' // pool row, not yet verified
  | 'basket' // verified, in the bundle
  | 'reserve' // verified, beyond n (hidden; refills a dropped basket row)
  | 'dropped' // verification or simulation rejected it
  | 'unaffordable' // verified but the wallet cannot cover it
  | 'removed' // the user took it out
  | 'swept' // minted in the last confirm

export interface SweepRow {
  key: string
  item: SweepResponseItem
  state: SweepRowState
  /** Human reason for dropped / unaffordable rows. */
  reason?: string
  /** Live values from the click-time read (wei); 0n while pending. */
  priceWei: bigint
  feeWei: bigint
  outlayWei: bigint
}

/** Initial simulation + at most two refill rounds per open (§4.3). */
export const MAX_SIMULATIONS = 3

/** The pool row is re-validated at the trust boundary even though the server validated it. */
export const validPoolRow = (it: SweepResponseItem): boolean => isAddress(it.address) && isValidTokenId(it.tokenId)

export const pendingRow = (it: SweepResponseItem): SweepRow => ({
  key: sweepKey(it.address, it.tokenId),
  item: it,
  state: 'pending',
  priceWei: 0n,
  feeWei: 0n,
  outlayWei: 0n,
})

/** Rows → basket items: only the LIVE values ever reach calldata. */
export const toBasketItem = (r: SweepRow): SweepBasketItem => ({
  address: r.item.address as Address,
  tokenId: BigInt(r.item.tokenId),
  priceWei: r.priceWei,
  feeWei: r.feeWei,
})

export const sumOutlay = (rows: readonly SweepRow[]): bigint => rows.reduce((s, r) => s + r.outlayWei, 0n)

export type Verified =
  | { ok: true; rows: SweepRow[]; gasCostWei: bigint | null }
  | { ok: false; reason: 'rpc' }

/**
 * Verify a pool page against live chain state and size the basket. Pure
 * orchestration over the lib helpers: ONE cross-collection aggregate3 for
 * price / supply / ownership / balance, the live per-collection mint fees, a
 * re-rank on live outlay, a balance trim, then an eth_call simulation of the
 * exact bundle (allowFailure on, nothing sent) that drops would-revert rows and
 * refills from the reserve. Invariant on return: every `basket` row passed the
 * last simulation it was part of, and the basket's outlay plus the gas reserve
 * fits the wallet's balance as read in the same aggregate.
 */
export async function verifyBasket(
  client: PublicClient,
  account: Address,
  pending: readonly SweepRow[],
  n: number,
): Promise<Verified> {
  // Nothing to verify is "nothing to sweep", not a failed read.
  if (pending.length === 0) return { ok: true, rows: [], gasCostWei: null }
  const refs = pending.map((r) => ({ collection: r.item.address as Address, tokenId: BigInt(r.item.tokenId) }))
  const { items: live, ethBalance } = await fetchEligibleTokensMulti(client, refs, account, 1n)
  // Null balance = the aggregate itself failed (see fetchEligibleTokensMulti):
  // "could not verify", never "nothing eligible".
  if (ethBalance === null) return { ok: false, reason: 'rpc' }

  let fees: Map<string, bigint>
  try {
    fees = await readMintFeesWithBound(client, live.map((l) => l.collection))
  } catch {
    return { ok: false, reason: 'rpc' }
  }

  const liveByKey = new Map(live.map((l) => [sweepKey(l.collection, l.tokenId.toString()), l]))
  const dropped: SweepRow[] = []
  const eligible: SweepRow[] = []
  for (const r of pending) {
    const l = liveByKey.get(r.key)
    if (!l) {
      dropped.push({ ...r, state: 'dropped', reason: 'sold out, ended, or already yours' })
      continue
    }
    if (l.pricePerToken <= 0n) {
      // The sweep is paid mints only; a price edited to 0 since the build is
      // excluded exactly as the index excludes it.
      dropped.push({ ...r, state: 'dropped', reason: 'now a free mint' })
      continue
    }
    const fee = fees.get(r.item.address.toLowerCase())
    if (fee === undefined) {
      dropped.push({ ...r, state: 'dropped', reason: 'mint fee unreadable' })
      continue
    }
    eligible.push({ ...r, state: 'reserve', priceWei: l.pricePerToken, feeWei: fee, outlayWei: l.pricePerToken + fee })
  }

  // Re-rank on LIVE outlay (the index's order may be stale), same rule as the index.
  const ranked = rankSweepCandidates(
    eligible.map((row) => {
      const t = row.item.createdAt ? Date.parse(row.item.createdAt) : Number.NaN
      return {
        address: row.item.address,
        tokenId: row.item.tokenId,
        outlayWei: row.outlayWei,
        artist: row.item.artist,
        createdAtMs: Number.isFinite(t) ? t : null,
        row,
      }
    }),
  ).map((x) => x.row)

  const budget = ethBalance - SWEEP_GAS_HEADROOM_WEI
  let basket = ranked.slice(0, n)
  const reserve = ranked.slice(n)
  const unaffordable: SweepRow[] = []
  {
    const t = trimToBudget(basket, budget)
    basket = t.kept
    unaffordable.push(...t.dropped)
  }

  // Simulate the exact bundle; drop would-revert rows; refill from the reserve
  // (ascending, so the first reserve row that does not fit ends the refill).
  const simDropped: SweepRow[] = []
  let simulations = 0
  while (basket.length > 0 && simulations < MAX_SIMULATIONS) {
    simulations++
    const sim = await simulateSweep(client, account, buildSweepCalls(basket.map(toBasketItem), account))
    if ('error' in sim) {
      if (sim.error === 'rpc') return { ok: false, reason: 'rpc' }
      // insufficient funds despite the headroom: shed the priciest row and retry.
      unaffordable.push(basket.pop()!)
      if (simulations >= MAX_SIMULATIONS) {
        // Out of simulations with nothing verified: the remainder never passed
        // a simulation, so it must not reach the wallet.
        unaffordable.push(...basket)
        basket = []
      }
      continue
    }
    const { kept, dropped: bad } = applySimulation(basket, sim.ok)
    basket = kept
    if (bad.length === 0) break
    simDropped.push(...bad)
    if (simulations >= MAX_SIMULATIONS) break // a refill would go unsimulated
    let room = budget - sumOutlay(basket)
    const refill: SweepRow[] = []
    while (basket.length + refill.length < n && reserve.length > 0 && reserve[0].outlayWei <= room) {
      const next = reserve.shift()!
      refill.push(next)
      room -= next.outlayWei
    }
    if (refill.length === 0) break
    basket = [...basket, ...refill]
  }

  // Gas refinement on the final strict bundle: one estimate upper-bounds every
  // shorter prefix, so shedding never needs a second estimate. Without an
  // estimate the constant headroom stands in, so the check never silently skips.
  const gasCostWei = await estimateSweepGasCost(client, account, buildSweepCalls(basket.map(toBasketItem), account))
  const gasReserve = gasCostWei ?? SWEEP_GAS_HEADROOM_WEI
  while (basket.length > 0 && ethBalance < sumOutlay(basket) + gasReserve) {
    unaffordable.push(basket.pop()!)
  }

  const rows: SweepRow[] = [
    ...basket.map((r) => ({ ...r, state: 'basket' as const })),
    ...simDropped.map((r) => ({ ...r, state: 'dropped' as const, reason: 'not mintable right now' })),
    ...unaffordable.map((r) => ({ ...r, state: 'unaffordable' as const, reason: 'needs more ETH' })),
    ...dropped,
    ...reserve.map((r) => ({ ...r, state: 'reserve' as const })),
  ]
  return { ok: true, rows, gasCostWei }
}
