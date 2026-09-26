'use client'

import { useCallback, useRef, useState } from 'react'
import { useConfig, usePublicClient, useWriteContract } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import type { Address, Hash, PublicClient } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useWalletRecovery } from '@/hooks/useWalletRecovery'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { trackFunnel } from '@/lib/funnel'
import { reportClientError } from '@/lib/clientError'
import { DEFAULT_COLLECT_COMMENT } from '@/lib/inprocess'
import { fetchEligibleTokensMulti, readMintFeesWithBound } from '@/lib/saleConfig'
import { rankSweepCandidates } from '@/lib/sweepRank'
import {
  SWEEP_DEFAULT_N,
  sweepKey,
  type SweepApiResponse,
  type SweepResponseItem,
} from '@/lib/sweepIndexCore'
import { MULTICALL3_ADDRESS, buildEthMintCall } from '@/lib/zoraMint'
import {
  SWEEP_GAS_HEADROOM_WEI,
  applySimulation,
  buildSweepCalls,
  sweepBundle,
  trimToBudget,
  type SweepBasketItem,
} from '@/lib/sweepBatch'
import { estimateSweepGasCost, simulateSweep } from '@/lib/sweepSimulate'

// The sweep, client half (SWEEP_IMPLEMENTATION.md §5.1). One state machine:
//
//   idle ─open→ loading ─→ verifying ─→ ready ─confirm→ minting ─→ confirming ─→ recording ─→ done
//                              └→ empty                    └→ error (the sheet re-opens to re-verify)
//
// The index (/api/sweep) is only a candidate pool. Everything that costs money
// is decided here from live chain state: ONE cross-collection aggregate3 for
// price / supply / ownership / balance, the live per-collection mint fees, a
// balance trim, then an eth_call simulation of the exact bundle (allowFailure
// on, nothing sent) that drops would-revert rows and refills from the reserve.
// What the user signs is the STRICT Multicall3 bundle (allowFailure off) on
// any wallet — no EIP-5792, no USDC — or a direct 1155.mint for a single item.

export type SweepStatus =
  | 'idle'
  | 'loading'
  | 'verifying'
  | 'ready'
  | 'empty'
  | 'minting'
  | 'confirming'
  | 'recording'
  | 'done'
  | 'error'

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

export interface UseSweepReturn {
  status: SweepStatus
  rows: SweepRow[]
  /** Basket size the sheet asked for. */
  n: number
  /** Σ outlay of the basket rows — the exact `value` that will be sent. */
  totalWei: bigint
  /** Rows trimmed because the wallet cannot cover them. */
  unaffordable: number
  /** Estimated gas cost of the strict bundle (wei), when an estimate was available. */
  gasCostWei: bigint | null
  /** When the pool was last rebuilt (from /api/sweep). */
  updatedAt: number | null
  result: { hash: Hash; minted: number } | null
  open: (n?: number) => Promise<void>
  remove: (key: string) => void
  restore: (key: string) => void
  confirm: () => Promise<{ hash: Hash; minted: number } | null>
}

const TOAST_ID = 'sweep'
// Initial simulation + at most two refill rounds per open (§4.3).
const MAX_SIMULATIONS = 3
const RECORD_ATTEMPTS = 3

const validPoolRow = (it: SweepResponseItem): boolean => isAddress(it.address) && isValidTokenId(it.tokenId)

const pendingRow = (it: SweepResponseItem): SweepRow => ({
  key: sweepKey(it.address, it.tokenId),
  item: it,
  state: 'pending',
  priceWei: 0n,
  feeWei: 0n,
  outlayWei: 0n,
})

const toBasketItem = (r: SweepRow): SweepBasketItem => ({
  address: r.item.address as Address,
  tokenId: BigInt(r.item.tokenId),
  priceWei: r.priceWei,
  feeWei: r.feeWei,
})

const sumOutlay = (rows: readonly SweepRow[]): bigint => rows.reduce((s, r) => s + r.outlayWei, 0n)

type Verified =
  | { ok: true; rows: SweepRow[]; gasCostWei: bigint | null }
  | { ok: false; reason: 'rpc' }

/**
 * Verify a pool page against live chain state and size the basket. Pure
 * orchestration over the lib helpers; every decision here is re-derived from
 * on-chain reads made in this call, never from the index's numbers.
 */
async function verifyBasket(
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
    fees = await readMintFeesWithBound(
      client,
      [...new Set(live.map((l) => l.collection.toLowerCase()))] as Address[],
    )
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

/** One /api/collect record per swept row, bounded retry (the server 403s until
 *  its own RPC sees the receipt), surfaced to the diagnostics sink on total loss. */
async function recordOne(row: SweepRow, account: Address, txHash: Hash): Promise<boolean> {
  const body = JSON.stringify({
    moment: { collectionAddress: row.item.address, tokenId: row.item.tokenId, chainId: base.id },
    account,
    amount: 1,
    comment: DEFAULT_COLLECT_COMMENT,
    pricePerToken: row.priceWei.toString(),
    currency: 'eth',
    txHash,
  })
  for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt))
    try {
      const res = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
      if (res.ok) return true
    } catch {
      // transport error — retry
    }
  }
  reportClientError('sweep.record_failed', {
    collectionAddress: row.item.address,
    tokenId: row.item.tokenId,
    txHash,
    account,
  })
  return false
}

export function useSweep(): UseSweepReturn {
  const config = useConfig()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  const ensureConnected = useEnsureConnected()
  const { consumeRetryFlag, showError, ackSuccess } = useWalletRecovery(TOAST_ID, 'Sweep')

  const [status, setStatus] = useState<SweepStatus>('idle')
  const [rows, setRowsState] = useState<SweepRow[]>([])
  const [n, setN] = useState<number>(SWEEP_DEFAULT_N)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [gasCostWei, setGasCostWei] = useState<bigint | null>(null)
  const [result, setResult] = useState<{ hash: Hash; minted: number } | null>(null)

  // confirm() reads the latest rows through a ref so a user removal between
  // render and click is never lost to a stale closure.
  const rowsRef = useRef<SweepRow[]>([])
  const setRows = useCallback((next: SweepRow[]) => {
    rowsRef.current = next
    setRowsState(next)
  }, [])
  // Synchronous re-entrance latch (a double-tap must not send two bundles).
  const inFlightRef = useRef(false)
  // Each open() bumps this; a verification that finishes after a newer open()
  // (size toggle, "sweep the next N") discards its result.
  const openSeqRef = useRef(0)
  const confirmRef = useRef<() => Promise<{ hash: Hash; minted: number } | null>>(() => Promise.resolve(null))

  const open = useCallback(
    async (size: number = SWEEP_DEFAULT_N) => {
      const seq = ++openSeqRef.current
      setN(size)
      setResult(null)
      setGasCostWei(null)
      setRows([])
      setStatus('loading')
      trackFunnel('sweep_open')

      const account = await ensureConnected()
      if (seq !== openSeqRef.current) return
      if (!account) {
        setStatus('idle')
        return
      }
      if (!publicClient) {
        setStatus('error')
        toast.error('Network unavailable')
        return
      }

      let data: SweepApiResponse
      try {
        const res = await fetch(`/api/sweep?n=${size}`)
        if (!res.ok) throw new Error(`sweep pool ${res.status}`)
        data = (await res.json()) as SweepApiResponse
      } catch {
        if (seq !== openSeqRef.current) return
        setStatus('error')
        toast.error('Could not load the sweep pool — try again')
        return
      }
      if (seq !== openSeqRef.current) return
      if (!data.enabled || data.items.length === 0) {
        setStatus('empty')
        return
      }
      setUpdatedAt(data.updatedAt)
      const pending = data.items.filter(validPoolRow).map(pendingRow)
      setRows(pending)
      setStatus('verifying')

      try {
        await ensureBase()
      } catch (err) {
        if (seq !== openSeqRef.current) return
        setStatus('error')
        showError(err, false, () => void open(size))
        return
      }

      const verified = await verifyBasket(publicClient, account, pending, size)
      if (seq !== openSeqRef.current) return
      if (!verified.ok) {
        setStatus('error')
        toast.error('Could not verify the sweep on-chain — try again')
        return
      }
      setRows(verified.rows)
      setGasCostWei(verified.gasCostWei)
      setStatus(verified.rows.some((r) => r.state === 'basket') ? 'ready' : 'empty')
    },
    [ensureBase, ensureConnected, publicClient, setRows, showError],
  )

  const remove = useCallback(
    (key: string) => {
      setRows(rowsRef.current.map((r) => (r.key === key && r.state === 'basket' ? { ...r, state: 'removed' } : r)))
    },
    [setRows],
  )

  const restore = useCallback(
    (key: string) => {
      setRows(rowsRef.current.map((r) => (r.key === key && r.state === 'removed' ? { ...r, state: 'basket' } : r)))
    },
    [setRows],
  )

  const confirm = useCallback(async () => {
    const isRetryAfterRecovery = consumeRetryFlag()
    if (inFlightRef.current) return null
    const basket = rowsRef.current.filter((r) => r.state === 'basket')
    if (basket.length === 0) return null
    if (!publicClient) {
      toast.error('Network unavailable')
      return null
    }
    // Authoritative signer read (reflects a wallet connected in this same tap).
    const account = getAccount(config).address
    if (!account) {
      toast.error('Connect a wallet to sweep')
      return null
    }
    inFlightRef.current = true
    trackFunnel('sweep_attempt')
    setStatus('minting')
    toast.loading(`Confirm in wallet — sweeping ${basket.length}…`, { id: TOAST_ID })

    try {
      await ensureBase()
      // The user could have switched networks between verification and this tap.
      if (getAccount(config).chainId !== base.id) {
        throw new Error('Switched off Base — retry to continue')
      }
      const items = basket.map(toBasketItem)
      let hash: Hash
      if (items.length === 1) {
        // A lone item takes the direct mint so Purchased.sender stays the user.
        const it = items[0]
        hash = await writeContractAsync({
          chainId: base.id,
          address: it.address,
          ...buildEthMintCall({
            tokenId: it.tokenId,
            mintTo: account,
            quantity: 1n,
            mintFee: it.feeWei,
            pricePerToken: it.priceWei,
            comment: DEFAULT_COLLECT_COMMENT,
          }),
          dataSuffix: BUILDER_DATA_SUFFIX,
        })
      } else {
        const calls = buildSweepCalls(items, account)
        hash = await writeContractAsync({
          chainId: base.id,
          address: MULTICALL3_ADDRESS,
          ...sweepBundle(calls),
          dataSuffix: BUILDER_DATA_SUFFIX,
        })
      }

      setStatus('confirming')
      toast.loading('Confirming on-chain…', { id: TOAST_ID })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 })
      if (receipt.status !== 'success') {
        throw new Error('Sweep reverted on-chain — nothing was charged')
      }

      setStatus('recording')
      toast.loading('Finalizing…', { id: TOAST_ID })
      await Promise.all(basket.map((row) => recordOne(row, account, hash)))

      setRows(rowsRef.current.map((r) => (r.state === 'basket' ? { ...r, state: 'swept' } : r)))
      const minted = basket.length
      setResult({ hash, minted })
      setStatus('done')
      toast.success(`Swept ${minted} artwork${minted === 1 ? '' : 's'}!`, { id: TOAST_ID })
      trackFunnel('sweep_success')
      ackSuccess()
      return { hash, minted }
    } catch (err) {
      setStatus('error')
      showError(err, isRetryAfterRecovery, () => {
        void confirmRef.current()
      })
      return null
    } finally {
      inFlightRef.current = false
    }
  }, [ackSuccess, config, consumeRetryFlag, ensureBase, publicClient, setRows, showError, writeContractAsync])

  confirmRef.current = confirm

  const basketRows = rows.filter((r) => r.state === 'basket')
  return {
    status,
    rows,
    n,
    totalWei: sumOutlay(basketRows),
    unaffordable: rows.filter((r) => r.state === 'unaffordable').length,
    gasCostWei,
    updatedAt,
    result,
    open,
    remove,
    restore,
    confirm,
  }
}
