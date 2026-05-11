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
  // Override the action slot under "view collection". Default = bulk
  // "collect all" button when ETH-eligible tokens exist, otherwise empty.
  primaryAction?: React.ReactNode
  // Above-the-fold hint — forwarded to the cover image so the first row's
  // LCP target doesn't lazy-load.
  priority?: boolean
}

export function CollectionCard({ collection, primaryAction, priority }: CollectionCardProps) {
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

  return (
    <article className="flex flex-col bg-[#161616] border border-[#2a2a2a] overflow-hidden">
      <Link
        href={`/collection/${c.contractAddress}`}
        className="relative aspect-square bg-[#111] block overflow-hidden group/img"
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
            <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
          </div>
        )}
      </Link>

      <div className="px-4 pt-4 pb-2 flex flex-col gap-1">
        <h3 className="text-sm text-[#efefef] font-mono truncate">{collectionName}</h3>
        {creatorLabel && (
          <Link
            href={adminAddr ? `/profile/${adminAddr}` : '#'}
            className="text-xs font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
          >
            {creatorLabel}
          </Link>
        )}
        {description && (
          <p className="text-xs font-mono text-[#555] mt-0.5 line-clamp-2">{description}</p>
        )}
      </div>

      <div className="px-4 pb-4 flex flex-col gap-1.5 mt-auto">
        <Link
          href={`/collection/${c.contractAddress}`}
          className="w-full py-2 text-center text-xs font-mono tracking-wider uppercase border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors"
        >
          view collection
        </Link>
        {primaryAction ?? (
          (c.ethEligibleTokenIds && c.ethEligibleTokenIds.length > 0) ||
          (c.usdcEligibleTokenIds && c.usdcEligibleTokenIds.length > 0) ? (
            <CollectAllAction
              collectionAddress={c.contractAddress}
              ethEligibleTokenIds={c.ethEligibleTokenIds ?? []}
              ethEligibleTotalWei={c.ethEligibleTotalWei ?? '0'}
              usdcEligibleTokenIds={c.usdcEligibleTokenIds ?? []}
              usdcEligibleTotalUsdc={c.usdcEligibleTotalUsdc ?? '0'}
            />
          ) : null
        )}
      </div>
    </article>
  )
}
