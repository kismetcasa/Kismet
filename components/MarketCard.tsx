'use client'

import { useState } from 'react'
import { useAccount, useWriteContract, useSignMessage, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { SEAPORT_ADDRESS, SEAPORT_ABI, deserializeOrder } from '@/lib/seaport'
import { BuyButton } from './BuyButton'
import type { Listing } from '@/lib/listings'
import { useEnsureBase } from '@/lib/useEnsureBase'

interface MarketCardProps {
  listing: Listing
  onRemove?: () => void
}

export function MarketCard({ listing, onRemove }: MarketCardProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { writeContractAsync } = useWriteContract()
  const { signMessageAsync } = useSignMessage()
  const publicClient = usePublicClient()
  const ensureBase = useEnsureBase()
  const [cancelling, setCancelling] = useState(false)

  const isSeller = address?.toLowerCase() === listing.seller.toLowerCase()
  // formatPrice handles both ETH (wei, 18dp) and USDC (base units, 6dp) and
  // renders the right suffix. Royalty pct is a ratio of two same-currency
  // amounts so it's currency-agnostic.
  const priceLabel = formatPrice(listing.price, listing.currency ?? 'eth')
  const royaltyPct = listing.price !== '0'
    ? ((Number(listing.royaltyAmount) / Number(listing.price)) * 100).toFixed(1)
    : '0'

  async function handleCancel() {
    if (!isConnected || !address) { openConnectModal?.(); return }

    setCancelling(true)
    toast.loading('Cancel listing in wallet…', { id: 'cancel' })

    try {
      await ensureBase()
      const order = deserializeOrder(listing.orderComponents)

      // On-chain cancel so the signed order can never be filled
      const hash = await writeContractAsync({
        chainId: base.id,
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'cancel',
        args: [[{
          offerer: order.offerer,
          zone: order.zone,
          offer: order.offer,
          consideration: order.consideration,
          orderType: order.orderType,
          startTime: order.startTime,
          endTime: order.endTime,
          zoneHash: order.zoneHash,
          salt: order.salt,
          conduitKey: order.conduitKey,
          counter: order.counter,
        }]],
      })

      // Don't update the backend until cancel actually confirms — a reverted
      // cancel would leave the order live on-chain but our UI would say cancelled.
      if (!publicClient) throw new Error('No RPC client available')
      toast.loading('Confirming cancellation…', { id: 'cancel' })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        throw new Error('Cancel transaction reverted on-chain')
      }

      const nonceRes = await fetch(`/api/profile/${address}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = await nonceRes.json()
      const message = `Cancel Kismet Art listing\nListing: ${listing.id}\nSeller: ${address.toLowerCase()}\nNonce: ${nonce}`
      toast.loading('Sign cancellation in wallet…', { id: 'cancel' })
      const signature = await signMessageAsync({ message })

      await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled', signature, nonce, signer: address }),
      })

      toast.success('Listing cancelled!', { id: 'cancel' })
      onRemove?.()
    } catch (err) {
      toast.error('Cancel failed', {
        id: 'cancel',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="bg-[#0d0d0d] flex flex-col">
      {/* Thumbnail */}
      <div className="aspect-square bg-[#111] overflow-hidden">
        {listing.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={listing.image}
            alt={listing.name ?? ''}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-mono text-[#efefef] truncate">
              {listing.name ?? 'untitled'}
            </p>
            <p className="text-xs font-mono text-[#555] mt-0.5">
              creator {shortAddress(listing.creatorAddress ?? '')}
            </p>
            <p className="text-xs font-mono text-[#333] mt-0.5">
              seller {shortAddress(listing.seller)}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-mono accent-grad">{priceLabel}</p>
            {Number(listing.royaltyAmount) > 0 && (
              <p className="text-xs font-mono text-[#333] mt-0.5">
                {royaltyPct}% royalty
              </p>
            )}
          </div>
        </div>

        {isSeller ? (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className={`w-full text-xs font-mono tracking-wider uppercase px-4 py-2.5 border border-[#2a2a2a] text-[#555] hover:border-red-900 hover:text-red-400 transition-colors disabled:opacity-40 ${cancelling ? 'cursor-not-allowed' : ''}`}
          >
            {cancelling ? 'cancelling…' : 'cancel listing'}
          </button>
        ) : (
          <BuyButton listing={listing} onBought={onRemove} className="w-full" />
        )}
      </div>
    </div>
  )
}
