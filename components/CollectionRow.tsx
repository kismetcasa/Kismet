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
  // Token ID minted as the collection cover at deploy time. Set by
  // the featured-collections-hydrated API either from CollectionMeta
  // KV (post-persistence) or inferred from the created-mints set
  // (for collections registered before the field was persisted).
  // Drives the highest-priority cover-vs-mint dedupe below.
  coverTokenId?: string
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
  // LCP hint — propagated to the cover image and the first visible
  // moment card so they aren't lazy-loaded.
  priority?: boolean
  // Lazy-mount off-screen cards in the mobile horizontal scroller.
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

  // The hydrator API already strips the cover-mint from c.moments
  // before slicing, so the slice math lands on the right number of
  // VISIBLE moments. Don't re-filter here.
  const displayMoments = c.moments
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

  const coverCard = (
    <article className="flex flex-col bg-[#161616] border border-line overflow-hidden h-full">
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
            sizes="(max-width: 1024px) 320px, 288px"
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
      <div className="flex flex-col gap-2 p-3 flex-1">
        <h3 className="text-sm font-mono text-ink truncate">{name}</h3>
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
    </article>
  )

  return (
    // <lg: single horizontal scroll (cover-card first, then ~320px
    // moment cards). lg+: cover-left + grid-right. Inline videos scroll
    // natively inside the scroller (clipped by its overflow).
    <article className="flex flex-col lg:flex-row border border-line bg-[#161616] overflow-hidden">
      <div className="hidden lg:flex flex-col lg:flex-shrink-0 lg:w-96 xl:w-96 lg:border-r lg:border-line">
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
              sizes="384px"
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

        <div className="flex flex-col gap-1 p-4 min-w-0 flex-1">
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

      <div className="overflow-x-auto flex gap-3 p-3 snap-x snap-mandatory [-webkit-overflow-scrolling:touch] lg:hidden">
        <div className="w-80 flex-shrink-0 snap-start">
          {coverCard}
        </div>
        {displayMoments.length === 0 ? (
          <div className="flex-1 flex items-center justify-center min-h-[160px]">
            <span className="text-xs font-mono text-muted">no moments yet</span>
          </div>
        ) : (
          displayMoments.map((m, idx) => (
            <div
              key={m.id || `${m.address}-${m.token_id}`}
              className="w-80 flex-shrink-0 snap-start"
            >
              {isMobile && idx > 0 ? (
                <LazyMount placeholderClassName="block w-full bg-[#161616] border border-line overflow-hidden">
                  {() => <MomentCard moment={m} priority={false} />}
                </LazyMount>
              ) : (
                <MomentCard moment={m} priority={false} />
              )}
            </div>
          ))
        )}
      </div>

      {/* lg+ moments — column-major flow preserves chronological
          top→bottom-then-right reading order across both rows. */}
      <div className="hidden lg:grid lg:flex-1 lg:min-w-0 lg:grid-cols-4 lg:grid-rows-2 lg:[grid-auto-flow:column] lg:gap-2 lg:p-3">
        {displayMoments.length === 0 ? (
          <div className="row-span-2 col-span-full flex items-center justify-center min-h-[160px]">
            <span className="text-xs font-mono text-muted">no moments yet</span>
          </div>
        ) : (
          displayMoments.map((m, idx) => (
            <MomentCard
              key={m.id || `${m.address}-${m.token_id}`}
              moment={m}
              compact
              priority={priority && idx === 0}
              fillCell
              isMobile={isMobile}
            />
          ))
        )}
      </div>
    </article>
  )
}
