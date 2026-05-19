'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { isOperatorAddress } from '@/lib/config'
import { MomentImage } from './MomentImage'
import { CollectAllAction } from './CollectAllAction'

/**
 * Shape we render — compatible with both inprocess `/api/collections` plural
 * (lightweight rows from `data.collections[]`) and `/api/collection` singular
 * (rich object with default_admin + timestamps). The optional fields fall
 * back gracefully when absent.
 */
export interface CollectionDisplay {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string; kismet_thumbhash?: string }
  // inprocess `/api/collection` (singular) extras — used when present
  default_admin?: { address?: string; username?: string }
  created_at?: string
  // Bulk-collect hydration from /api/collections?feed=1. When ETH and/or
  // USDC eligibility is non-empty, the card surfaces a "collect all" button
  // that fires a single EIP-5792 wallet_sendCalls bundle covering both legs;
  // otherwise the action slot is empty.
  ethEligibleTokenIds?: string[]
  ethEligibleTotalWei?: string
  usdcEligibleTokenIds?: string[]
  usdcEligibleTotalUsdc?: string
}

interface CollectionCardProps {
  collection: CollectionDisplay
  // Above-the-fold hint — forwarded to the cover image so the first row's
  // LCP target doesn't lazy-load.
  priority?: boolean
  /**
   * Compact mode for the grid-view horizontal swiper. Drops the
   * description and collapses to a single action button (collect-all
   * when eligible, otherwise view-collection) so the card fits ~180px
   * wide alongside other compact cards in the same scroller.
   */
  compact?: boolean
  /**
   * Force the creator chip on/off independent of `compact`. In compact
   * mode the chip is hidden by default to save vertical space; the
   * grid view opts it back in for identity.
   */
  showCreator?: boolean
}

export function CollectionCard({ collection, priority, compact, showCreator }: CollectionCardProps) {
  const c = collection
  const collectionName = c.metadata?.name || c.name || shortAddress(c.contractAddress)
  const description = c.metadata?.description
  const [imgFailed, setImgFailed] = useState(false)

  // Suppress the chip when default_admin resolves to the operator smart
  // wallet (platform-deployed on behalf of an artist) — it has no Kismet
  // profile and the plural endpoint doesn't surface a distinct artist
  // EOA we could fall back to.
  const rawAdminAddr = c.default_admin?.address
  const adminAddr = isOperatorAddress(rawAdminAddr) ? undefined : rawAdminAddr
  const initialUsername = isOperatorAddress(rawAdminAddr) ? undefined : c.default_admin?.username
  const initialName = initialUsername
    ?? (adminAddr ? shortAddress(adminAddr) : null)
  const [creatorLabel, setCreatorLabel] = useState<string | null>(
    initialName ? (initialUsername ? `@${initialUsername}` : initialName) : null,
  )
  useEffect(() => {
    if (!adminAddr || initialUsername) return
    fetchCreatorProfile(adminAddr).then(({ name }) => {
      // profileCache returns username if set, otherwise shortAddress. The
      // `@` prefix only makes sense when a real username resolved.
      const isUsername = name && name !== shortAddress(adminAddr)
      setCreatorLabel(isUsername ? `@${name}` : shortAddress(adminAddr))
    })
  }, [adminAddr, initialUsername])

  // Creator chip default: visible non-compact, hidden compact. `showCreator`
  // overrides either direction — grid view passes true so the chip stays.
  const renderCreator = showCreator ?? !compact
  const hasCollectAll =
    (c.ethEligibleTokenIds && c.ethEligibleTokenIds.length > 0) ||
    (c.usdcEligibleTokenIds && c.usdcEligibleTokenIds.length > 0)

  return (
    <article className="flex flex-col bg-[#161616] border border-line overflow-hidden [content-visibility:auto] [contain-intrinsic-size:auto_500px]">
      <Link
        href={`/collection/${c.contractAddress}`}
        className="relative aspect-square bg-surface block overflow-hidden group/img"
      >
        {c.metadata?.image && !imgFailed ? (
          <MomentImage
            src={c.metadata.image}
            alt={collectionName}
            fill
            className="object-contain transition-transform duration-500 group-hover/img:scale-105"
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            onAllError={() => setImgFailed(true)}
            priority={priority}
            preferProxy
            thumbhash={c.metadata.kismet_thumbhash}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-xs">no preview</span>
          </div>
        )}
      </Link>

      <div className={`${compact ? 'px-2 pt-2 pb-1.5 gap-1' : 'px-4 pt-4 pb-2 gap-1'} flex flex-col`}>
        <h3 className={`${compact ? 'text-[11px]' : 'text-sm'} text-ink font-mono truncate`}>
          {collectionName}
        </h3>
        {renderCreator && creatorLabel && (
          <Link
            href={adminAddr ? `/profile/${adminAddr}` : '#'}
            className={`${compact ? 'text-[10px]' : 'text-xs'} font-mono text-muted hover:text-dim transition-colors max-w-full truncate min-w-0`}
          >
            {creatorLabel}
          </Link>
        )}
        {!compact && description && (
          <p className="text-xs font-mono text-muted mt-0.5 line-clamp-2">{description}</p>
        )}
      </div>

      {/* Actions. Compact: single action — collect-all when eligible,
          otherwise view-collection — to keep the card at the same height
          as compact moment cards in the swiper. Non-compact: view + (optional)
          collect-all stacked. */}
      {compact ? (
        <div className="px-2 pb-2 mt-auto">
          {hasCollectAll ? (
            <CollectAllAction
              collectionAddress={c.contractAddress}
              ethEligibleTokenIds={c.ethEligibleTokenIds ?? []}
              ethEligibleTotalWei={c.ethEligibleTotalWei ?? '0'}
              usdcEligibleTokenIds={c.usdcEligibleTokenIds ?? []}
              usdcEligibleTotalUsdc={c.usdcEligibleTotalUsdc ?? '0'}
            />
          ) : (
            <Link
              href={`/collection/${c.contractAddress}`}
              className="w-full py-1.5 text-center text-[10px] font-mono tracking-wider uppercase border border-line text-muted hover:border-muted hover:text-ink transition-colors block"
            >
              view
            </Link>
          )}
        </div>
      ) : (
        <div className="px-4 pb-4 flex flex-col gap-1.5 mt-auto">
          <Link
            href={`/collection/${c.contractAddress}`}
            className="w-full py-2 text-center text-xs font-mono tracking-wider uppercase border border-line text-muted hover:border-muted hover:text-ink transition-colors"
          >
            view collection
          </Link>
          {hasCollectAll && (
            <CollectAllAction
              collectionAddress={c.contractAddress}
              ethEligibleTokenIds={c.ethEligibleTokenIds ?? []}
              ethEligibleTotalWei={c.ethEligibleTotalWei ?? '0'}
              usdcEligibleTokenIds={c.usdcEligibleTokenIds ?? []}
              usdcEligibleTotalUsdc={c.usdcEligibleTotalUsdc ?? '0'}
            />
          )}
        </div>
      )}
    </article>
  )
}
