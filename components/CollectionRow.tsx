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
import { LazyMount } from './LazyMount'

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
  // Lazy-mount cards beyond the first in the mobile horizontal scroller.
  // The row shows ~1.3 cards at 320px each on a phone, so cards 2+ are
  // off-screen until the user swipes — no reason to pay their mount cost
  // (2 wagmi reads + 3 fetches each) up front.
  isMobile?: boolean
}

export function CollectionRow({ collection, priority, isMobile }: CollectionRowProps) {
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
    // Two layouts share a single tree, picked by responsive utilities:
    //   <lg: stacked — full-width cover, view-collection + collect-all
    //     stacked underneath, then a horizontal-scrolling row of
    //     full-feature moment cards (320px each, ~1.3 visible on phone).
    //   lg+: side-by-side — cover + info column on the left, 5×2 column-
    //     major grid of compact moment cards on the right.
    // SharedVideoProvider's clip-path keeps position:fixed video elements
    // from painting past the horizontal scroller's edges on <lg.
    <article className="flex flex-col lg:flex-row border border-line bg-[#161616] overflow-hidden">
      <div className="flex flex-col lg:flex-shrink-0 lg:w-64 xl:w-72 lg:border-r lg:border-line">
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
              sizes="(max-width: 1024px) 100vw, 288px"
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
          {/* <lg name overlay — desktop has a full info section below the
              cover so the overlay is redundant there. */}
          <span className="lg:hidden absolute inset-x-0 bottom-0 px-3 py-1.5 text-xs font-mono text-ink bg-gradient-to-t from-[#0d0d0d]/95 to-transparent truncate">
            {name}
          </span>
        </Link>

        {/* Mobile-only minimal action stack — view-collection button on top,
            price chip + collect-all on the row beneath it. */}
        <div className="flex flex-col gap-2 p-3 lg:hidden">
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

        {/* lg+ info: name, creator, description, view + collect-all */}
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

      {/* <lg moments — horizontal scroll, non-compact cards at ~320px so
          the creator/collection chips and full action row fit, ~1.3
          visible at once invites the scroll. */}
      <div className="overflow-x-auto flex gap-3 p-3 snap-x snap-mandatory [-webkit-overflow-scrolling:touch] border-t border-line lg:hidden">
        {c.moments.length === 0 ? (
          <div className="flex-1 flex items-center justify-center min-h-[160px]">
            <span className="text-xs font-mono text-muted">no moments yet</span>
          </div>
        ) : (
          c.moments.map((m, idx) => (
            <div
              key={m.id || `${m.address}-${m.token_id}`}
              className="w-80 flex-shrink-0 snap-start"
            >
              {isMobile && idx > 0 ? (
                <LazyMount placeholderClassName="block w-full bg-[#161616] border border-line overflow-hidden">
                  {() => <MomentCard moment={m} priority={false} />}
                </LazyMount>
              ) : (
                <MomentCard moment={m} priority={priority && idx === 0} />
              )}
            </div>
          ))
        )}
      </div>

      {/* lg+ moments — 5×2 column-major grid of compact cards, reading
          top → bottom of each column then right. */}
      <div className="hidden lg:flex-1 lg:min-w-0 lg:grid lg:grid-cols-5 lg:grid-rows-2 lg:[grid-auto-flow:column] lg:gap-2 lg:p-3">
        {c.moments.length === 0 ? (
          <div className="col-span-full row-span-full flex items-center justify-center min-h-[160px]">
            <span className="text-xs font-mono text-muted">no moments yet</span>
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
