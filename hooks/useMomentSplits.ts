'use client'

import { useEffect, useState } from 'react'
import { useAccount, useBalance, useReadContract, useSignMessage } from 'wagmi'
import { base } from 'viem/chains'
import { toast } from 'sonner'
import { ERC20_ABI, USDC_BASE, ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'
import { formatPrice } from '@/lib/inprocess'
import { toastError } from '@/lib/toast'
import type { SplitRecipient } from '@/lib/splits'
import type { CollectCurrency } from '@/hooks/useDirectCollect'

interface Options {
  address: string
  tokenId: string
  // Creator (resolved EOA) or a moment admin per the parent view. Either
  // grants distribute rights; recipients are detected here from the stored
  // split list. The distribute API authorizes the same three roles.
  isCreator: boolean
  isAdmin: boolean
  // Sale currency of the moment — selects which balance to read off the
  // split contract (native ETH vs USDC) and which token inprocess distributes.
  currency: CollectCurrency
}

interface SplitsState {
  hasSplits: boolean
  recipients: SplitRecipient[]
  splitAddress: `0x${string}` | undefined
  // True when the connected wallet is the creator, an admin, or a split
  // recipient — the three roles allowed to trigger a distribution.
  canDistribute: boolean
  // Undistributed proceeds sitting on the split, formatted for display
  // (e.g. "0.5 ETH" / "$5"). undefined while the balance read is pending.
  pendingFormatted: string | undefined
  // The connected wallet's share of `pendingFormatted` (balance × their %).
  // undefined when the viewer isn't a recipient or the read is pending.
  pendingShareFormatted: string | undefined
  // True when there's a non-zero balance to distribute. Gates the button so
  // we don't sponsor a no-op tx.
  hasPending: boolean
  distribute: (currency: CollectCurrency) => Promise<void>
  distributing: boolean
  distributeHash: string | null
}

/**
 * Bundles the splits state for MomentDetailView: the stored recipient list
 * (rendered for every viewer in the splits panel) plus the distribute flow
 * for the creator, admins, and recipients.
 *
 * `splitAddress`, the balance reads, and the distribute action are gated on
 * `canDistribute` because only those roles use them. `currency` selects the
 * balance to read (and is what inprocess needs as `tokenAddress=USDC_BASE`
 * for USDC moments, else it defaults to ETH and distributes nothing from a
 * USDC split).
 */
export function useMomentSplits({ address, tokenId, isCreator, isAdmin, currency }: Options): SplitsState {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
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
  const canDistribute = hasSplits && (isCreator || isAdmin || !!viewerRecipient)

  const { data: splitAddress } = useReadContract({
    address: address as `0x${string}`,
    abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
    functionName: 'getCreatorRewardRecipient',
    args: [BigInt(tokenId)],
    query: { enabled: canDistribute },
  })

  // Undistributed proceeds live on the split contract until distribute is
  // called. ETH moments read the native balance; USDC moments read the ERC20
  // balance. Both hooks are declared unconditionally (rules of hooks) and
  // gated to the relevant currency via `enabled`.
  const { data: ethBalance } = useBalance({
    address: splitAddress,
    chainId: base.id,
    query: { enabled: canDistribute && !!splitAddress && currency === 'eth' },
  })
  const { data: usdcBalance } = useReadContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: splitAddress ? [splitAddress] : undefined,
    query: { enabled: canDistribute && !!splitAddress && currency === 'usdc' },
  })

  const pendingRaw =
    currency === 'usdc'
      ? (usdcBalance as bigint | undefined)
      : ethBalance?.value
  const hasPending = pendingRaw !== undefined && pendingRaw > 0n
  const pendingFormatted =
    pendingRaw === undefined ? undefined : formatPrice(pendingRaw.toString(), currency)
  const pendingShareFormatted =
    pendingRaw === undefined || !viewerRecipient
      ? undefined
      : formatPrice(
          ((pendingRaw * BigInt(viewerRecipient.percentAllocation)) / 100n).toString(),
          currency,
        )

  async function distribute(currency: CollectCurrency) {
    if (!splitAddress) { toast.error('Split address not found'); return }
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    const addr = splitAddress
    setDistributing(true)
    try {
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')
      const message = `Distribute Kismet split\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nSplit: ${addr.toLowerCase()}\nCurrency: ${currency}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })
      const res = await fetch('/api/distribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          splitAddress: addr,
          collectionAddress: address,
          tokenId,
          chainId: 8453,
          currency,
          callerAddress: connectedAddress,
          signature,
          nonce,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Distribution failed')
      if (!data.hash) throw new Error('Distribute submitted but no tx hash returned')
      setDistributeHash(data.hash)
      toast.success('Distributed!', { id: 'distribute' })
    } catch (err) {
      toastError('Distribution', err, { id: 'distribute' })
    } finally {
      setDistributing(false)
    }
  }

  return {
    hasSplits,
    recipients,
    splitAddress,
    canDistribute,
    pendingFormatted,
    pendingShareFormatted,
    hasPending,
    distribute,
    distributing,
    distributeHash,
  }
}
