'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useWriteContract, useSignMessage, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useTextContent } from '@/lib/textCache'
import { SEAPORT_ADDRESS, SEAPORT_ABI, deserializeOrder } from '@/lib/seaport'
import { BuyButton } from './BuyButton'
import { MomentImage } from './MomentImage'
import Link from 'next/link'
import type { Listing } from '@/lib/listings'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError } from '@/lib/toast'

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
  const [creatorName, setCreatorName] = useState(() => shortAddress(listing.creatorAddress ?? ''))
  const [sellerName, setSellerName] = useState(() => shortAddress(listing.seller))
  const [cancelling, setCancelling] = useState(false)
  // Inline two-tap confirmation guards against accidental cancels — the first
  // tap arms the button (label flips, 3s timeout to disarm), the second tap
  // actually fires the wallet sig. Costs gas + ends the listing, so we want
  // a deliberate gesture before launching the tx.
  const [confirmArmed, setConfirmArmed] = useState(false)
  const armTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current)
  }, [])

  useEffect(() => {
    if (listing.creatorAddress) {
      fetchCreatorProfile(listing.creatorAddress).then(({ name }) => setCreatorName(name))
    }
  }, [listing.creatorAddress])

  useEffect(() => {
    fetchCreatorProfile(listing.seller).then(({ name }) => setSellerName(name))
  }, [listing.seller])

  const isTextListing = listing.contentMime === 'text/plain'
  const textSnippet = useTextContent(isTextListing ? listing.contentUri : undefined)
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
      const message = `Cancel Kismet listing\nListing: ${listing.id}\nSeller: ${address.toLowerCase()}\nNonce: ${nonce}`
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
      toastError('Cancel', err, { id: 'cancel' })
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div className="bg-[#161616] border border-line flex flex-col">
      {/* Thumbnail */}
      <div className="relative aspect-square bg-surface overflow-hidden">
        {listing.image ? (
          <MomentImage
            src={listing.image}
            alt={listing.name ?? ''}
            fill
            className="object-contain"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : isTextListing ? (
          <div className="w-full h-full flex flex-col p-5 bg-gradient-to-br from-raised to-[#0a0a0a]">
            <span className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">writing</span>
            {listing.name && (
              <p className="text-sm sm:text-base font-mono text-ink truncate mb-2">
                {listing.name}
              </p>
            )}
            {textSnippet && (
              <p className="text-xs sm:text-sm font-mono text-[#bbb] line-clamp-6 leading-relaxed whitespace-pre-wrap">
                {textSnippet}
              </p>
            )}
            {!listing.name && !textSnippet && (
              <p className="text-xs sm:text-sm font-mono text-[#bbb]">untitled</p>
            )}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-xs">no preview</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-4 flex flex-col gap-3">
        <div>
          <p className="text-sm font-mono text-ink truncate mb-1.5">
            {listing.name ?? 'untitled'}
          </p>
          <div className="flex items-center justify-between">
            {listing.creatorAddress ? (
              <Link
                href={`/profile/${listing.creatorAddress}`}
                className="text-xs font-mono text-muted hover:text-dim transition-colors"
              >
                {creatorName}
              </Link>
            ) : <span />}
            <Link
              href={`/profile/${listing.seller}`}
              className="text-xs font-mono text-muted hover:text-dim transition-colors"
            >
              {sellerName}
            </Link>
          </div>
          <div className="flex items-center justify-between mt-0.5">
            {Number(listing.royaltyAmount) > 0 ? (
              <p className="text-xs font-mono text-faint">{royaltyPct}% royalty</p>
            ) : <span />}
            <p className="text-xs font-mono accent-grad">{priceLabel}</p>
          </div>
        </div>

        {isSeller ? (
          <button
            onClick={() => {
              if (cancelling) return
              if (!confirmArmed) {
                setConfirmArmed(true)
                if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current)
                armTimeoutRef.current = setTimeout(() => setConfirmArmed(false), 3000)
                return
              }
              if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current)
              setConfirmArmed(false)
              handleCancel()
            }}
            disabled={cancelling}
            className={`w-full text-xs font-mono tracking-wider uppercase px-4 py-2.5 border transition-colors disabled:opacity-40 ${cancelling ? 'cursor-not-allowed' : ''} ${
              confirmArmed
                ? 'border-red-700 text-red-400'
                : 'border-line text-muted hover:border-red-900 hover:text-red-400'
            }`}
          >
            {cancelling ? 'cancelling…' : confirmArmed ? 'tap again to confirm' : 'cancel listing'}
          </button>
        ) : (
          <BuyButton listing={listing} onBought={onRemove} className="w-full" />
        )}
      </div>
    </div>
  )
}
