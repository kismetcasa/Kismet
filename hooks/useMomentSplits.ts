'use client'

import { useEffect, useMemo, useState } from 'react'
import { useAccount, usePublicClient, useReadContracts, useSignMessage } from 'wagmi'
import { toast } from 'sonner'
import {
  ERC20_ABI,
  MULTICALL3_ADDRESS,
  MULTICALL3_BALANCE_ABI,
  USDC_BASE,
} from '@/lib/zoraMint'
import { decodePayoutTargets } from '@/lib/distributePlan'
import { payoutTargetCalls, filterDistributableTargets } from '@/lib/payoutTargets'
import { formatPrice } from '@/lib/inprocess'
import { toastError } from '@/lib/toast'
import type { SplitRecipient } from '@/lib/splits'
import type { CollectCurrency } from '@/hooks/useDirectCollect'

interface Options {
  address: string
  tokenId: string
  // Creator (resolved EOA) or a moment admin per the parent view. Either
  // grants distribute rights; recipients are detected here from the stored
  // split list. The distribute API authorizes the same roles.
  isCreator: boolean
  isAdmin: boolean
  // Kismet platform admin (ADMIN_ADDRESS) — a break-glass role that may
  // distribute any moment's splits (e.g. to unstick a payout a user reports
  // as missing). The distribute API authorizes the same address; the
  // signature gate keeps it to the real admin EOA.
  isPlatformAdmin: boolean
}

/** One distributable pot: a payout target holding a balance in one currency. */
interface PendingUnit {
  splitAddress: `0x${string}`
  currency: CollectCurrency
  amount: bigint
}

interface SplitsState {
  hasSplits: boolean
  recipients: SplitRecipient[]
  /** The moment's on-chain payout targets — usually one contract, two when the
   *  creator-reward recipient and the sale fundsRecipient have been driven
   *  apart. `undefined` while the reads are pending. */
  splitAddresses: string[] | undefined
  // True when the connected wallet may trigger a distribution: creator,
  // moment admin, split recipient, or platform admin.
  canDistribute: boolean
  // True when the connected wallet is one of the split recipients. Lets the
  // view distinguish a recipient/creator from a platform-admin override.
  isRecipient: boolean
  // Undistributed proceeds sitting on the payout targets, formatted for
  // display (e.g. "0.5 ETH", or "0.5 ETH · $5" when both currencies are
  // sitting there). undefined while the balance reads are pending.
  pendingFormatted: string | undefined
  // The connected wallet's share of `pendingFormatted` (balance × their %).
  // undefined when the viewer isn't a recipient or the reads are pending.
  pendingShareFormatted: string | undefined
  // True when there's a non-zero balance to distribute. Gates the button so
  // we don't sponsor a no-op tx.
  hasPending: boolean
  distribute: () => Promise<void>
  distributing: boolean
  distributeHash: string | null
}

/**
 * Bundles the splits state for MomentDetailView: the stored recipient list
 * (rendered for every viewer in the splits panel) plus the distribute flow
 * for the creator, moment admins, recipients, and the platform admin.
 *
 * Distribution settles EVERY funded (payout target × currency) pair, not just
 * the moment's sale currency against a single contract. Two independent
 * reasons:
 *   • a moment has two on-chain payout pointers that can diverge (see
 *     decodePayoutTargets — In Process's moment-manage page moves one of them);
 *   • one pot can hold BOTH currencies (a USDC sale whose split also collected
 *     ETH creator rewards or a prior ETH sale), and inprocess distributes only
 *     the token it is asked for, so a sale-currency-only read left the other
 *     leg stranded and the button reading "nothing to distribute".
 * The reads and the distribute action are gated on `canDistribute` because
 * only those roles use them.
 */
export function useMomentSplits({
  address,
  tokenId,
  isCreator,
  isAdmin,
  isPlatformAdmin,
}: Options): SplitsState {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const publicClient = usePublicClient()
  const [hasSplits, setHasSplits] = useState(false)
  const [recipients, setRecipients] = useState<SplitRecipient[]>([])
  const [distributing, setDistributing] = useState(false)
  const [distributeHash, setDistributeHash] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setHasSplits(false)
    setRecipients([])
    fetch(`/api/moment/splits?collectionAddress=${address}&tokenId=${tokenId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (cancelled) return
        setHasSplits(d.hasSplits === true)
        setRecipients(Array.isArray(d.recipients) ? d.recipients : [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address, tokenId])

  const connectedLower = connectedAddress?.toLowerCase()
  const viewerRecipient = connectedLower
    ? recipients.find((r) => r.address.toLowerCase() === connectedLower)
    : undefined
  // A Kismet mint-time split record is no longer required: In Process lets an
  // artist point a moment's fundsRecipient at a split after mint, and those
  // moments have no record. The panel is still gated on money actually being
  // there (`hasPending` below) and the API re-checks the on-chain binding, so
  // widening this can't offer a distribute that has nothing to settle.
  const canDistribute = isCreator || isAdmin || isPlatformAdmin || !!viewerRecipient

  // Guard BigInt() — a non-numeric tokenId would throw during render.
  const tokenIdBig = /^\d+$/.test(tokenId) ? BigInt(tokenId) : null
  const targetsEnabled = canDistribute && tokenIdBig !== null

  const { data: targetReads } = useReadContracts({
    contracts: tokenIdBig !== null
      ? payoutTargetCalls(address as `0x${string}`, tokenIdBig)
      : [],
    query: { enabled: targetsEnabled },
  })

  const [splitAddresses, setSplitAddresses] = useState<string[] | undefined>(undefined)
  useEffect(() => {
    if (!targetReads) { setSplitAddresses(undefined); return }
    let cancelled = false
    const decoded = decodePayoutTargets(targetReads)
    // Which candidates are really distributable — see
    // filterDistributableTargets. `hasSplits` (a Kismet mint-time record) is
    // what lets the primary pointer through unprobed; without it every
    // candidate must prove it is a 0xSplits wallet, so a plain payout wallet
    // never surfaces as "to distribute".
    const fallback = hasSplits ? decoded.slice(0, 1) : []
    const settle = publicClient
      ? filterDistributableTargets(publicClient, decoded, { trustPrimary: hasSplits })
      : Promise.resolve(fallback)
    settle
      .then((t) => { if (!cancelled) setSplitAddresses(t) })
      .catch(() => { if (!cancelled) setSplitAddresses(fallback) })
    return () => { cancelled = true }
  }, [targetReads, publicClient, hasSplits])

  // Undistributed proceeds live on the payout target until distribute is
  // called. Read BOTH currencies for EVERY target in one multicall — native
  // ETH via Multicall3's balance reader so it rides in the same aggregate3 as
  // the USDC balanceOf.
  const balanceContracts = useMemo(
    () =>
      (splitAddresses ?? []).flatMap((t) => [
        {
          address: MULTICALL3_ADDRESS,
          abi: MULTICALL3_BALANCE_ABI,
          functionName: 'getEthBalance' as const,
          args: [t as `0x${string}`] as const,
        },
        {
          address: USDC_BASE,
          abi: ERC20_ABI,
          functionName: 'balanceOf' as const,
          args: [t as `0x${string}`] as const,
        },
      ]),
    [splitAddresses],
  )
  const { data: balanceReads, refetch: refetchBalances } = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: canDistribute && balanceContracts.length > 0 },
  })

  // The funded (target, currency) pairs — the exact work list distribute()
  // walks, and the basis for every figure below.
  const units = useMemo<PendingUnit[] | undefined>(() => {
    if (!splitAddresses) return undefined
    if (splitAddresses.length === 0) return []
    if (!balanceReads) return undefined
    const out: PendingUnit[] = []
    splitAddresses.forEach((t, i) => {
      const legs: [CollectCurrency, unknown][] = [
        ['eth', balanceReads[i * 2]?.status === 'success' ? balanceReads[i * 2].result : 0n],
        ['usdc', balanceReads[i * 2 + 1]?.status === 'success' ? balanceReads[i * 2 + 1].result : 0n],
      ]
      for (const [currency, raw] of legs) {
        if (typeof raw === 'bigint' && raw > 0n) {
          out.push({ splitAddress: t as `0x${string}`, currency, amount: raw })
        }
      }
    })
    return out
  }, [splitAddresses, balanceReads])

  const hasPending = !!units && units.length > 0
  // Sum per currency across targets, then render one line. Two entries only
  // when a pot genuinely holds both ETH and USDC.
  const { pendingFormatted, pendingShareFormatted } = useMemo(() => {
    if (!units) return { pendingFormatted: undefined, pendingShareFormatted: undefined }
    const totals: Record<CollectCurrency, bigint> = { eth: 0n, usdc: 0n }
    for (const u of units) totals[u.currency] += u.amount
    const pct = viewerRecipient ? BigInt(viewerRecipient.percentAllocation) : null
    const render = (scale: (v: bigint) => bigint): string =>
      (['eth', 'usdc'] as const)
        .filter((c) => totals[c] > 0n)
        .map((c) => formatPrice(scale(totals[c]).toString(), c))
        .join(' · ')
    const total = render((v) => v)
    return {
      pendingFormatted: total || formatPrice('0', 'eth'),
      pendingShareFormatted: pct === null || !total ? undefined : render((v) => (v * pct) / 100n),
    }
  }, [units, viewerRecipient])

  /**
   * Settle every funded pot. One signature + one /api/distribute call per
   * (target, currency) — the server's signed message is bound to both, and
   * inprocess distributes a single token per call. The common case is exactly
   * one unit, so exactly one wallet prompt.
   *
   * Sequential on purpose: each call is a platform-sponsored on-chain tx via a
   * shared relay, and a failure part-way must not leave later units firing
   * blind. Partial success is reported honestly rather than as an error —
   * /distribute is NOT idempotent, so "failed" copy on a settled pot invites a
   * double payout.
   */
  async function distribute() {
    if (!units || units.length === 0) { toast.error('Nothing to distribute'); return }
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    setDistributing(true)
    let settled = 0
    let lastError: unknown = null
    try {
      for (const unit of units) {
        const addr = unit.splitAddress
        const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
        if (!nonceRes.ok) throw new Error(`Could not fetch nonce (HTTP ${nonceRes.status})`)
        const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
        if (!nonce) throw new Error('Could not fetch nonce (empty response)')
        const message = `Distribute Kismet split\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nSplit: ${addr.toLowerCase()}\nCurrency: ${unit.currency}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
        const signature = await signMessageAsync({ message })
        const res = await fetch('/api/distribute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            splitAddress: addr,
            collectionAddress: address,
            tokenId,
            chainId: 8453,
            currency: unit.currency,
            callerAddress: connectedAddress,
            signature,
            nonce,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as { hash?: string; error?: string }
        if (!res.ok) {
          // Remember and keep going: an unrelated pot must still settle.
          lastError = new Error(data.error ?? 'Distribution failed')
          continue
        }
        settled++
        // A 2xx means the tx was submitted; the hash is a convenience for the
        // basescan link and its absence is NOT a failure (see the API route).
        if (data.hash) setDistributeHash(data.hash)
      }

      if (settled === 0) throw lastError ?? new Error('Distribution failed')
      const failed = units.length - settled
      toast.success(
        failed > 0
          ? `Distributed ${settled} of ${units.length} payouts`
          : 'Distributed!',
        { id: 'distribute' },
      )
    } catch (err) {
      toastError('Distribution', err, { id: 'distribute' })
    } finally {
      setDistributing(false)
      // Drained pots read back as empty, flipping the button to "nothing to
      // distribute" instead of inviting a second (non-idempotent) click.
      refetchBalances().catch(() => {})
    }
  }

  return {
    hasSplits,
    recipients,
    splitAddresses,
    canDistribute,
    isRecipient: !!viewerRecipient,
    pendingFormatted,
    pendingShareFormatted,
    hasPending,
    distribute,
    distributing,
    distributeHash,
  }
}
