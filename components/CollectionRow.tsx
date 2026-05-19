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
    // Single flex-row tree at all breakpoints — cover on the left, mints
    // on the right.
    //   <lg: cover is just the 128px square (name overlaid at the bottom);
    //     mints scroll horizontally (single visual row).
    //   lg+: cover widens, info section appears below it; mints become a
    //     2-row × 5-col grid with grid-auto-flow:column so chronological
    //     reading goes top → bottom of each column, then right (1@top-left,
    //     2 directly below it, 3 top of the next column, etc.).
    // SharedVideoProvider's clip-path keeps the position:fixed video
    // elements from painting past the horizontal scroller's edges on <lg.
    <article className="flex border border-line bg-[#161616] overflow-hidden">
      <div className="flex-shrink-0 w-32 lg:w-64 xl:w-72 lg:flex lg:flex-col lg:border-r lg:border-line">
        <Link
          href={`/collection/${c.contractAddress}`}
          className="relative aspect-square w-full block overflow-hidden bg-surface group/img"
        >
          {isAdmin && (
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                toggleFeaturedCollection(c.contractAddress)
              }}
              className={`absolute top-1.5 left-1.5 z-10 min-w-10 min-h-10 flex items-center justify-center transition-colors ${
                isFeatured ? 'text-yellow-400' : 'text-faint hover:text-dim'
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
              sizes="(max-width: 1024px) 128px, 288px"
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
          {/* <lg name overlay: the info section is hidden on smaller
              screens, so the collection still needs a label inside the row. */}
          <span className="lg:hidden absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] font-mono text-ink bg-gradient-to-t from-[#0d0d0d]/95 to-transparent truncate">
            {name}
          </span>
        </Link>

        <div className="hidden lg:flex flex-col gap-1 p-4 min-w-0 flex-1">
          <h3 className="text-base font-mono text-ink truncate">{name}</h3>
          {creatorLabel && (
            <Link
              href={adminAddr ? `/profile/${adminAddr}` : '#'}
              className="text-xs font-mono text-muted hover:text-dim transition-colors w-fit"
            >
              {creatorLabel}
            </Link>
          )}
          {description && (
            <p className="text-xs font-mono text-muted mt-1 line-clamp-3">{description}</p>
          )}

          <div className="flex flex-col gap-2 mt-auto pt-3">
            <Link
              href={`/collection/${c.contractAddress}`}
              className="w-full px-3 py-1.5 text-center text-xs font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors"
            >
              view collection
            </Link>
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

      <div className="flex-1 min-w-0 overflow-x-auto flex gap-2 p-2 snap-x snap-mandatory [-webkit-overflow-scrolling:touch] lg:overflow-visible lg:flex-none lg:grid lg:grid-cols-5 lg:grid-rows-2 lg:[grid-auto-flow:column] lg:gap-2 lg:p-3 lg:snap-none">
        {c.moments.length === 0 ? (
          <div className="flex-1 lg:col-span-full lg:row-span-full flex items-center justify-center min-h-[160px]">
            <span className="text-xs font-mono text-muted">no moments yet</span>
          </div>
        ) : (
          c.moments.map((m, idx) => (
            <div
              key={m.id || `${m.address}-${m.token_id}`}
              className="w-32 flex-shrink-0 snap-start lg:w-auto lg:flex-shrink"
            >
              <MomentCard moment={m} compact priority={priority && idx === 0} />
            </div>
          ))
        )}
      </div>
    </article>
  )
}
