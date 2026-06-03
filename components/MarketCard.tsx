'use client'

import { useEffect, useRef, useState } from 'react'
import { useAccount, useWriteContract, useSignMessage, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Pin } from 'lucide-react'
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
  /**
   * Compact mode for the dense grid view. Drops seller chip and
   * royalty % so only creator + price + buy/cancel remain — keeps
   * the card visually consistent with compact MomentCards beside it.
   */
  compact?: boolean
  /**
   * Force the creator chip on/off independent of `compact`. Grid view
   * passes true; non-compact mode renders it by default.
   */
  showCreator?: boolean
  /**
   * Above-the-fold hint. Forwards next/image priority so the first
   * row of a market grid doesn't lazy-load behind hydration.
   */
  priority?: boolean
  /**
   * Owner-only "pin to profile" affordance, mirroring MomentCard. Provided
   * by ProfileView only on the owner's own Listings; `pinned` drives the
   * filled/outline pushpin overlaid bottom-left of the thumbnail.
   */
  pinned?: boolean
  onTogglePin?: () => void
}

export function MarketCard({ listing, onRemove, compact, showCreator, priority, pinned, onTogglePin }: MarketCardProps) {
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
  // Creator chip default: visible non-compact, hidden compact. `showCreator`
  // overrides either direction so grid view can opt the chip back in.
  const renderCreator = showCreator ?? !compact
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
        {/* Owner-only "pin to profile" toggle — see MomentCard. The thumbnail
            isn't a navigation link here, so stopPropagation alone suffices. */}
        {onTogglePin && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin()
            }}
            className={`absolute bottom-1.5 left-1.5 z-10 min-w-9 min-h-9 flex items-center justify-center transition-colors ${
              pinned ? 'text-accent' : 'text-faint hover:text-dim'
            }`}
            title={pinned ? 'Unpin from profile' : 'Pin to profile'}
            aria-label={pinned ? 'Unpin from profile' : 'Pin to profile'}
          >
            <Pin size={15} fill={pinned ? 'currentColor' : 'none'} strokeWidth={1.5} />
          </button>
        )}
        {listing.image ? (
          <MomentImage
            src={listing.image}
            alt={listing.name ?? ''}
            fill
            className="object-contain"
            sizes={compact
              ? '(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw'
              : '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw'}
            priority={priority}
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
      <div className={`${compact ? 'p-2 gap-2' : 'p-4 gap-3'} flex flex-col`}>
        <div>
          <p className={`${compact ? 'text-[11px] mb-1' : 'text-sm mb-1.5'} font-mono text-ink truncate`}>
            {listing.name ?? 'untitled'}
          </p>
          {compact ? (
            // Compact: creator chip (optional) + price on one row. Seller
            // chip and royalty % live on the detail page; at ~180px wide
            // there's no room for them here.
            <div className="flex items-center justify-between gap-2">
              {renderCreator && listing.creatorAddress ? (
                <Link
                  href={`/profile/${listing.creatorAddress}`}
                  className="text-[10px] font-mono text-muted hover:text-dim transition-colors truncate min-w-0"
                >
                  {creatorName}
                </Link>
              ) : <span />}
              <p className="text-[10px] font-mono accent-grad flex-shrink-0">{priceLabel}</p>
            </div>
          ) : (
            <>
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
            </>
          )}
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
            className={`w-full font-mono tracking-wider uppercase border transition-colors disabled:opacity-40 ${compact ? 'text-[10px] px-2 py-1.5' : 'text-xs px-4 py-2.5'} ${cancelling ? 'cursor-not-allowed' : ''} ${
              confirmArmed
                ? 'border-red-700 text-red-400'
                : 'border-line text-muted hover:border-red-900 hover:text-red-400'
            }`}
          >
            {cancelling
              ? 'cancelling…'
              : confirmArmed
                ? (compact ? 'tap again' : 'tap again to confirm')
                : (compact ? 'cancel' : 'cancel listing')}
          </button>
        ) : (
          <BuyButton listing={listing} onBought={onRemove} className="w-full" compact={compact} />
        )}
      </div>
    </div>
  )
}
