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
import { canonicalMediaId } from '@/lib/media/canonicalMediaId'

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

  // Skip the moment whose image IS the collection cover so the cover
  // NFT doesn't visually appear twice (once as the cover-card, once as
  // a mint card). Two signals, OR'd:
  //
  //   1. canonicalMediaId: same Arweave txid / IPFS CID regardless of
  //      which gateway URL form each side carries. Catches the case
  //      where cover and minted token point at the same uploaded
  //      object — i.e. the creator re-used one upload for both.
  //
  //   2. kismet_thumbhash: deterministic perceptual hash of image
  //      bytes generated server-side at upload time. Catches the more
  //      common case where the same image is uploaded TWICE through
  //      the deploy flow — once as the cover and once as the first
  //      minted token — landing on two separate Arweave txids but with
  //      identical bytes (so identical thumbhashes).
  //
  // collect-all eligibility lists are server-computed and passed
  // separately, so the hidden moment is still collectable.
  const coverMediaId = canonicalMediaId(c.metadata?.image)
  const coverThumbhash = c.metadata?.kismet_thumbhash?.trim() || undefined
  const displayMoments = c.moments.filter((m) => {
    if (coverMediaId && canonicalMediaId(m.metadata?.image) === coverMediaId) {
      return false
    }
    const mt = m.metadata?.kismet_thumbhash?.trim()
    if (coverThumbhash && mt && mt === coverThumbhash) {
      return false
    }
    return true
  })
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
    // moment cards). lg+: cover-left + grid-right. SharedVideoProvider's
    // clip-path keeps position:fixed videos inside the mobile scroller.
    <article className="flex flex-col lg:flex-row border border-line bg-[#161616] overflow-hidden">
      <div className="hidden lg:flex flex-col lg:flex-shrink-0 lg:w-80 xl:w-96 lg:border-r lg:border-line">
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
              sizes="(min-width: 1280px) 384px, 320px"
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

      {/* lg+ moments — 2 fixed rows that scroll horizontally so up to 20
          moments fit alongside the cover card. Column-major flow means
          items still read top→bottom then right, matching the mobile
          single-row scroller's chronological order. */}
      <div className="hidden lg:grid lg:flex-1 lg:min-w-0 lg:grid-rows-2 lg:[grid-auto-flow:column] lg:[grid-auto-columns:200px] lg:gap-2 lg:p-3 lg:overflow-x-auto">
        {displayMoments.length === 0 ? (
          <div className="row-span-2 flex items-center justify-center min-h-[160px]">
            <span className="text-xs font-mono text-muted">no moments yet</span>
          </div>
        ) : (
          displayMoments.map((m, idx) => (
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
