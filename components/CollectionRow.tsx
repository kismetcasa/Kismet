'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Star } from 'lucide-react'
import { shortAddress, type Moment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { isOperatorAddress } from '@/lib/config'
import { useAdmin } from '@/contexts/AdminContext'
import { MomentCard } from './MomentCard'
import { MomentImage } from './MomentImage'
import { CollectAllAction } from './CollectAllAction'

export interface FeaturedCollectionRow {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string; kismet_thumbhash?: string }
  default_admin?: { address?: string; username?: string }
  moments: Moment[]
  ethEligibleTokenIds: string[]
  ethEligibleTotalWei: string
  usdcEligibleTokenIds: string[]
  usdcEligibleTotalUsdc: string
  featuredAt: number
}

interface CollectionRowProps {
  collection: FeaturedCollectionRow
  // Above-the-fold hint forwarded to the cover image (and propagated to the
  // first mint card so the row's LCP candidate isn't lazy-loaded).
  priority?: boolean
}

export function CollectionRow({ collection, priority }: CollectionRowProps) {
  const c = collection
  const name = c.metadata?.name || c.name || shortAddress(c.contractAddress)
  const description = c.metadata?.description
  const [imgFailed, setImgFailed] = useState(false)
  const { isAdmin, featuredCollectionAddrs, toggleFeaturedCollection } = useAdmin()
  const isFeatured = featuredCollectionAddrs.has(c.contractAddress.toLowerCase())

  // `default_admin` resolves to the operator smart wallet when the
  // platform deployed on the artist's behalf. The plural endpoint
  // doesn't surface a distinct artist EOA, so we suppress the chip
  // rather than dead-link to an empty profile.
  const rawAdminAddr = c.default_admin?.address
  const adminAddr = isOperatorAddress(rawAdminAddr) ? undefined : rawAdminAddr
  const initialUsername = isOperatorAddress(rawAdminAddr) ? undefined : c.default_admin?.username
  const [creatorLabel, setCreatorLabel] = useState<string | null>(
    initialUsername ? `@${initialUsername}` : adminAddr ? shortAddress(adminAddr) : null,
  )
  useEffect(() => {
    if (!adminAddr || initialUsername) return
    fetchCreatorProfile(adminAddr).then(({ name: resolved }) => {
      const isUsername = resolved && resolved !== shortAddress(adminAddr)
      setCreatorLabel(isUsername ? `@${resolved}` : shortAddress(adminAddr))
    })
  }, [adminAddr, initialUsername])

  return (
    <article className="border border-[#2a2a2a] bg-[#161616] overflow-hidden">
      {/* Header: cover image + collection info side-by-side, full row
          width. Was a 5/12 left column with the mints to the right; flipped
          to a horizontal header so the mints grid below can use the full
          width and lay out 10-across at readable sizes. */}
      <div className="flex flex-col sm:flex-row gap-4 p-4 border-b border-[#2a2a2a]">
        <Link
          href={`/collection/${c.contractAddress}`}
          className="relative aspect-square w-full sm:w-40 md:w-48 flex-shrink-0 block overflow-hidden bg-[#111] group/img"
        >
          {isAdmin && (
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                toggleFeaturedCollection(c.contractAddress)
              }}
              className={`absolute top-2 left-2 z-10 p-1 transition-colors ${
                isFeatured ? 'text-yellow-400' : 'text-[#333] hover:text-[#888]'
              }`}
              title={isFeatured ? 'Unfeature' : 'Feature'}
            >
              <Star size={16} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
            </button>
          )}
          {c.metadata?.image && !imgFailed ? (
            <MomentImage
              src={c.metadata.image}
              alt={name}
              fill
              className="object-contain transition-transform duration-500 group-hover/img:scale-105"
              sizes="(max-width: 640px) 100vw, 192px"
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

        <div className="flex flex-col gap-1 min-w-0 flex-1">
          <h3 className="text-base font-mono text-[#efefef] truncate">{name}</h3>
          {creatorLabel && (
            <Link
              href={adminAddr ? `/profile/${adminAddr}` : '#'}
              className="text-xs font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
            >
              {creatorLabel}
            </Link>
          )}
          {description && (
            <p className="text-xs font-mono text-[#555] mt-1 line-clamp-3">{description}</p>
          )}

          <div className="flex flex-wrap gap-2 mt-auto pt-3">
            <Link
              href={`/collection/${c.contractAddress}`}
              className="px-4 py-1.5 text-center text-xs font-mono border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
            >
              view collection
            </Link>
            <div className="flex-1 min-w-[10rem]">
              <CollectAllAction
                collectionAddress={c.contractAddress}
                ethEligibleTokenIds={c.ethEligibleTokenIds}
                ethEligibleTotalWei={c.ethEligibleTotalWei}
                usdcEligibleTokenIds={c.usdcEligibleTokenIds}
                usdcEligibleTotalUsdc={c.usdcEligibleTotalUsdc}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Mints grid: up to 20 moments in chronological order (oldest at
          top-left). Static layout — was a horizontal scroller, which let
          the SharedVideoProvider's position:fixed video element paint
          past the article's clip into the page margin (cards scrolled
          off-screen still had on-page slots). A static grid keeps every
          slot inside the article so the pool can't paint outside it.
          10-across at xl matches the curator's request; falls back to
          fewer columns below xl so cards stay legible at narrower
          viewports. Compact MomentCard mode keeps image + name +
          price·supply + collect button visible at ~130px-wide cards. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-10 gap-2 p-3">
        {c.moments.length === 0 ? (
          <div className="col-span-full flex items-center justify-center min-h-[200px]">
            <span className="text-xs font-mono text-[#555]">no moments yet</span>
          </div>
        ) : (
          c.moments.map((m, idx) => (
            <MomentCard
              key={m.id || `${m.address}-${m.token_id}`}
              moment={m}
              compact
              priority={priority && idx === 0}
            />
          ))
        )}
      </div>
    </article>
  )
}
