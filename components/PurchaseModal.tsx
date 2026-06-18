'use client'

import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { formatPrice } from '@/lib/inprocess'
import { MomentImage } from './MomentImage'
import type { Listing } from '@/lib/listings'

interface PurchaseModalProps {
  listing: Listing
  onConfirm: () => void
  onClose: () => void
}

export function PurchaseModal({ listing, onConfirm, onClose }: PurchaseModalProps) {
  useBodyScrollLock(true)
  useEscapeKey(onClose, true)

  const currency = listing.currency ?? 'eth'
  const price = BigInt(listing.price)
  const platformFee = BigInt(listing.platformFee ?? '0')
  const royalty = BigInt(listing.royaltyAmount)

  const priceLabel = formatPrice(listing.price, currency)
  const feeLabel = platformFee > 0n ? formatPrice(listing.platformFee, currency) : null
  const royaltyLabel = royalty > 0n ? formatPrice(listing.royaltyAmount, currency) : null

  const feePct = price > 0n
    ? ((Number(platformFee) / Number(price)) * 100).toFixed(1)
    : '0'
  const royaltyPct = price > 0n
    ? ((Number(royalty) / Number(price)) * 100).toFixed(1)
    : '0'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-[#161616] border border-line w-full max-w-sm">
        {listing.image && (
          <div className="relative aspect-square bg-surface">
            <MomentImage
              src={listing.image}
              alt={listing.name ?? ''}
              fill
              className="object-contain"
              sizes="384px"
            />
          </div>
        )}

        <div className="p-5 flex flex-col gap-4">
          <div>
            <p className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">
              Complete purchase
            </p>
            <p className="text-sm font-mono text-ink truncate">
              {listing.name ?? 'untitled'}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            {feeLabel && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-faint">
                  Platform fee ({feePct}%)
                </span>
                <span className="text-xs font-mono text-faint">{feeLabel}</span>
              </div>
            )}
            {royaltyLabel && (
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-faint">
                  Creator royalty ({royaltyPct}%)
                </span>
                <span className="text-xs font-mono text-faint">{royaltyLabel}</span>
              </div>
            )}
            <div className="border-t border-line pt-2 flex items-center justify-between">
              <span className="text-xs font-mono text-dim">You pay</span>
              <span className="text-sm font-mono accent-grad">{priceLabel}</span>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 text-xs font-mono tracking-wider uppercase border border-line text-muted hover:text-dim transition-colors px-4 py-2.5"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className="flex-1 text-xs font-mono tracking-wider uppercase border border-accent text-accent hover:bg-accent/10 transition-colors px-4 py-2.5"
            >
              Buy now
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
