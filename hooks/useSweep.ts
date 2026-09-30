'use client'

import { useCallback, useRef, useState } from 'react'
import { useConfig, usePublicClient, useWriteContract } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import type { Address, Hash } from 'viem'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useWalletRecovery } from '@/hooks/useWalletRecovery'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { trackFunnel } from '@/lib/funnel'
import { reportClientError } from '@/lib/clientError'
import { DEFAULT_COLLECT_COMMENT } from '@/lib/inprocess'
import { SWEEP_DEFAULT_N, type SweepApiResponse } from '@/lib/sweepIndexCore'
import { MULTICALL3_ADDRESS, buildEthMintCall } from '@/lib/zoraMint'
import { buildSweepCalls, countSweepMints, recordAttemptSchedule, sweepBundle } from '@/lib/sweepBatch'
import {
  pendingRow,
  sumOutlay,
  toBasketItem,
  validPoolRow,
  verifyBasket,
  type SweepRow,
} from '@/lib/sweepVerify'

export type { SweepRow, SweepRowState } from '@/lib/sweepVerify'

// The sweep, client half (SWEEP_IMPLEMENTATION.md §5.1). One state machine:
//
//   idle ─open→ loading ─→ verifying ─→ ready ─confirm→ minting ─→ confirming ─→ recording ─→ done
//                              └→ empty                    └→ error (the sheet re-opens to re-verify)
//
// The index (/api/sweep) is only a candidate pool. Everything that costs money
// is decided from live chain state in lib/sweepVerify (verifyBasket): ONE
// cross-collection aggregate3 for price / supply / ownership / balance, the
// live per-collection mint fees, a balance trim, then an eth_call simulation of
// the exact bundle (allowFailure on, nothing sent) that drops would-revert rows
// and refills from the reserve. What the user signs is the STRICT Multicall3
// bundle (allowFailure off) on any wallet — no EIP-5792, no USDC — or a direct
// 1155.mint for a single item.

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

interface UseSweepReturn {
  status: SweepStatus
  rows: SweepRow[]
  /** Basket size the sheet asked for. */
  n: number
  /** Σ outlay of the basket rows — the exact `value` that will be sent. */
  totalWei: bigint
  /** Rows trimmed because the wallet cannot cover them. */
  unaffordable: number
  result: { hash: Hash; minted: number } | null
  open: (n?: number) => Promise<void>
  remove: (key: string) => void
  restore: (key: string) => void
  confirm: () => Promise<{ hash: Hash; minted: number } | null>
}

const TOAST_ID = 'sweep'

// The sweep in flight for a signer, from the moment the wallet prompt opens
// until its receipt is seen: a prompt still open (hash null), or a bundle sent
// but never seen mined (the receipt wait timed out, or the sheet was closed
// while it was confirming). Module-level, not a ref: the sheet (and with it
// this hook) unmounts when the user closes it — a backdrop click during the
// prompt is enough — and a second bundle must never be signed over one that
// may still land. open() and confirm() check it for the same signer before
// anything can be sent; each attempt clears only its own record, so a stale
// instance resolving late cannot erase a newer one's. A full page reload is
// the one way to lose it.
interface PendingSweep {
  account: Address
  hash: Hash | null
}
let pendingSweep: PendingSweep | null = null

/** One /api/collect record per swept row. The server 403s until its own RPC
 *  sees the receipt (the client waited on ITS RPC, so the two can disagree for
 *  a few seconds), so 403, 5xx and transport errors are retried on the
 *  schedule of recordAttemptSchedule; a 429 (the per-IP budget is gone) or a
 *  4xx validation answer ends the attempts. A row that never records is
 *  surfaced to the diagnostics sink. */
async function recordOne(row: SweepRow, account: Address, txHash: Hash, delaysMs: readonly number[]): Promise<boolean> {
  const body = JSON.stringify({
    moment: { collectionAddress: row.item.address, tokenId: row.item.tokenId, chainId: base.id },
    account,
    amount: 1,
    comment: DEFAULT_COLLECT_COMMENT,
    pricePerToken: row.priceWei.toString(),
    currency: 'eth',
    txHash,
  })
  for (const delay of delaysMs) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    try {
      const res = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      })
      if (res.ok) return true
      if (res.status !== 403 && res.status < 500) break
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
  // The signer the current rows were verified for (ownership, balance,
  // simulation are all per-account) and the size they were fetched at, so
  // confirm() can refuse a basket that was verified for a different wallet.
  const verifiedForRef = useRef<Address | null>(null)
  const nRef = useRef<number>(SWEEP_DEFAULT_N)

  const open = useCallback(
    async (size: number = SWEEP_DEFAULT_N) => {
      const seq = ++openSeqRef.current
      setN(size)
      nRef.current = size
      verifiedForRef.current = null
      setResult(null)
      setRows([])
      setStatus('loading')

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
      // Never re-send over a sweep that may still land: one receipt check,
      // then either proceed (verification excludes whatever it minted) or ask
      // the user to look at the wallet.
      const held = pendingSweep
      if (held && held.account.toLowerCase() === account.toLowerCase()) {
        if (held.hash === null) {
          setStatus('error')
          toast.error('Your last sweep is still waiting in the wallet — approve or reject it before trying again')
          return
        }
        const mined = await publicClient.getTransactionReceipt({ hash: held.hash }).catch(() => null)
        if (seq !== openSeqRef.current) return
        if (!mined) {
          setStatus('error')
          toast.error('Your last sweep is still pending — check your wallet before trying again')
          return
        }
        if (pendingSweep === held) pendingSweep = null
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
      const pending = data.items.filter(validPoolRow).map(pendingRow)
      setRows(pending)
      setStatus('verifying')

      // Verification is read-only against the Base client, so the wallet is
      // not asked to switch chains until the user actually taps sweep.
      const verified = await verifyBasket(publicClient, account, pending, size)
      if (seq !== openSeqRef.current) return
      if (!verified.ok) {
        setRows([])
        setStatus('error')
        toast.error('Could not verify the sweep on-chain — try again')
        return
      }
      verifiedForRef.current = account
      setRows(verified.rows)
      setStatus(verified.rows.some((r) => r.state === 'basket') ? 'ready' : 'empty')
    },
    [ensureConnected, publicClient, setRows],
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
    // Verified for one signer, signed by another (account switched in the
    // wallet since open): the ownership / balance / simulation checks do not
    // transfer, so re-verify for this signer instead of sending.
    if (verifiedForRef.current?.toLowerCase() !== account.toLowerCase()) {
      toast('Wallet changed — re-verifying', { id: TOAST_ID, description: undefined })
      void open(nRef.current)
      return null
    }
    // A sweep by this signer is still in flight (a prompt open in a sheet that
    // was closed, or a bundle not yet seen mined): never send over it. The
    // re-open runs the pending check and tells the user what to do.
    if (pendingSweep && pendingSweep.account.toLowerCase() === account.toLowerCase()) {
      void open(nRef.current)
      return null
    }
    inFlightRef.current = true
    trackFunnel('sweep_attempt')
    setStatus('minting')
    // One toast id per flow (the recovery toast's contract). A new attempt
    // must not inherit the previous failure's description: sonner merges
    // options for the same id, so it is cleared here explicitly.
    toast.loading(`Confirm in wallet — sweeping ${basket.length}…`, { id: TOAST_ID, description: undefined })

    let attempt: PendingSweep | null = null
    try {
      await ensureBase()
      // The user could have switched networks between verification and this tap.
      if (getAccount(config).chainId !== base.id) {
        throw new Error('Switched off Base — retry to continue')
      }
      const items = basket.map(toBasketItem)
      // Recorded BEFORE the prompt: a sheet closed and reopened while the wallet
      // is still asking must not verify and sign a second bundle.
      attempt = { account, hash: null }
      pendingSweep = attempt
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

      attempt.hash = hash
      setStatus('confirming')
      toast.loading('Confirming on-chain…', { id: TOAST_ID })
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 })
      if (pendingSweep === attempt) pendingSweep = null
      if (receipt.status !== 'success') {
        throw new Error('Sweep reverted on-chain — nothing was charged')
      }
      // Success is the receipt SHOWING the mints, not its status: a wallet can
      // replace a pending transaction (a speed-up carries the same mints under
      // a new hash; a cancel mints nothing), and the receipt returned is the
      // replacement's. Everything downstream uses the hash that actually mined.
      const minedHash = receipt.transactionHash
      if (countSweepMints(receipt.logs, items, account) !== items.length) {
        throw new Error('The transaction was replaced in the wallet — check it before trying again')
      }

      setStatus('recording')
      toast.loading('Finalizing…', { id: TOAST_ID })
      const delays = recordAttemptSchedule(basket.length)
      await Promise.all(basket.map((row) => recordOne(row, account, minedHash, delays)))

      setRows(rowsRef.current.map((r) => (r.state === 'basket' ? { ...r, state: 'swept' } : r)))
      const minted = basket.length
      setResult({ hash: minedHash, minted })
      setStatus('done')
      toast.success(`Swept ${minted} artwork${minted === 1 ? '' : 's'}!`, { id: TOAST_ID })
      trackFunnel('sweep_success')
      ackSuccess()
      return { hash: minedHash, minted }
    } catch (err) {
      // No hash → nothing was sent (rejected, or the send failed): release the
      // record. With a hash it stays until a receipt is seen — that is the guard.
      if (attempt && attempt.hash === null && pendingSweep === attempt) pendingSweep = null
      setStatus('error')
      showError(err, isRetryAfterRecovery, () => {
        void confirmRef.current()
      })
      return null
    } finally {
      inFlightRef.current = false
    }
  }, [ackSuccess, config, consumeRetryFlag, ensureBase, open, publicClient, setRows, showError, writeContractAsync])

  confirmRef.current = confirm

  const basketRows = rows.filter((r) => r.state === 'basket')
  return {
    status,
    rows,
    n,
    totalWei: sumOutlay(basketRows),
    unaffordable: rows.filter((r) => r.state === 'unaffordable').length,
    result,
    open,
    remove,
    restore,
    confirm,
  }
}
