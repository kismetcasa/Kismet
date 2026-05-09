'use client'

import { useEffect, useState } from 'react'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'
import { toast } from 'sonner'
import { ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'
import { toastError } from '@/lib/toast'
import type { CollectCurrency } from '@/hooks/useDirectCollect'

interface Options {
  address: string
  tokenId: string
  isCreator: boolean
}

interface SplitsState {
  hasSplits: boolean
  splitAddress: `0x${string}` | undefined
  distribute: (currency: CollectCurrency) => Promise<void>
  distributing: boolean
  distributeHash: string | null
}

/**
 * Bundles the creator-only "distribute split earnings" flow shared between
 * MomentModal and MomentDetailView:
 *   1. Polls /api/moment/splits to check the kismetart:splits:* flag (only
 *      moments minted with multiple splits via /api/mint expose this UI).
 *   2. Reads the on-chain split contract address via Zora's
 *      getCreatorRewardRecipient (gated until both isCreator and hasSplits).
 *   3. distribute(currency) signs a nonce'd message and POSTs to
 *      /api/distribute. Currency is injected by the caller — the inprocess
 *      side needs tokenAddress=USDC_BASE for USDC moments, otherwise the
 *      call defaults to ETH and a USDC splits contract distributes nothing.
 */
export function useMomentSplits({ address, tokenId, isCreator }: Options): SplitsState {
  const { address: connectedAddress } = useAccount()
  const { signMessageAsync } = useSignMessage()
  const [hasSplits, setHasSplits] = useState(false)
  const [distributing, setDistributing] = useState(false)
  const [distributeHash, setDistributeHash] = useState<string | null>(null)

  useEffect(() => {
    if (!isCreator) return
    fetch(`/api/moment/splits?collectionAddress=${address}&tokenId=${tokenId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setHasSplits(d.hasSplits === true))
      .catch(() => {})
  }, [address, tokenId, isCreator])

  const { data: splitAddress } = useReadContract({
    address: address as `0x${string}`,
    abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
    functionName: 'getCreatorRewardRecipient',
    args: [BigInt(tokenId)],
    query: { enabled: isCreator && hasSplits },
  })

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
      const message = `Distribute Kismet Art split\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nSplit: ${addr.toLowerCase()}\nCurrency: ${currency}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
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

  return { hasSplits, splitAddress, distribute, distributing, distributeHash }
}
