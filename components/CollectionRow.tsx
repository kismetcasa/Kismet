'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Star, EyeOff } from 'lucide-react'
import { shortAddress, type Moment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { isOperatorAddress } from '@/lib/config'
import { useAdmin } from '@/contexts/AdminContext'
import { isVideoMoment } from '@/lib/media/isVideo'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
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
  // first mint tile so the row's LCP candidate isn't lazy-loaded).
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
    <article className="grid grid-cols-1 md:grid-cols-12 border border-[#2a2a2a] bg-[#161616] overflow-hidden">
      {/* Hero: cover + details. md+ takes 5/12, mobile stacks full width. */}
      <div className="md:col-span-5 flex flex-col">
        <Link
          href={`/collection/${c.contractAddress}`}
          className="relative aspect-square block overflow-hidden bg-[#111] group/img"
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
              sizes="(max-width: 768px) 100vw, 41vw"
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

        <div className="px-4 pt-4 pb-4 flex flex-col gap-1 flex-1">
          <h3 className="text-sm font-mono text-[#efefef] truncate">{name}</h3>
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

          <div className="flex flex-col gap-1.5 mt-auto pt-3">
            <Link
              href={`/collection/${c.contractAddress}`}
              className="w-full py-1.5 text-center text-xs font-mono border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
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

      {/* Mints grid. md+ takes 7/12 and lays out up to 20 mints in
          chronological order — oldest at top-left, newest at bottom-right.
          Was a horizontal scroller; cards past the viewport edge would
          drag the SharedVideoProvider's position:fixed video element
          outside the article's overflow-hidden boundary (paints into
          the page margin). A static grid keeps every slot inside the
          article, so the pool can't paint past it. Compact tiles
          (image-only, click → moment detail) keep cards readable at
          5-across without cramming a full MomentCard into ~130px. */}
      <div className="md:col-span-7 grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 p-3">
        {c.moments.length === 0 ? (
          <div className="col-span-full flex items-center justify-center min-h-[200px]">
            <span className="text-xs font-mono text-[#555]">no moments yet</span>
          </div>
        ) : (
          c.moments.map((m, idx) => (
            <MomentTile
              key={m.id || `${m.address}-${m.token_id}`}
              moment={m}
              priority={priority && idx === 0}
            />
          ))
        )}
      </div>
    </article>
  )
}

// Compact preview tile used inside a featured collection row. Full
// MomentCard has too much chrome (creator chip, collection chip, action
// row) to fit a 5-per-row grid — the collection chip would just repeat
// the parent row's label anyway. The tile renders the image (or video,
// via the shared element pool) and surfaces admin/hidden affordances;
// click opens the moment detail page exactly like clicking the image
// on the full card does.
function MomentTile({ moment, priority }: { moment: Moment; priority?: boolean }) {
  const [imgError, setImgError] = useState(false)
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const meta = moment.metadata ?? {}
  const isFeatured = featuredKeys.has(`${moment.address.toLowerCase()}:${moment.token_id}`)
  const isVideo = isVideoMoment(meta)
  return (
    <Link
      href={`/moment/${moment.address}/${moment.token_id}`}
      title={meta.name ?? `#${moment.token_id}`}
      className="group/tile relative aspect-square bg-[#111] border border-[#2a2a2a] overflow-hidden block"
    >
      {isAdmin && (
        <button
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            toggleFeatured(moment.address, moment.token_id)
          }}
          className={`absolute top-1 left-1 z-10 p-1 transition-colors ${
            isFeatured ? 'text-yellow-400' : 'text-[#333] hover:text-[#888]'
          }`}
          title={isFeatured ? 'Unfeature' : 'Feature'}
        >
          <Star size={12} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
        </button>
      )}
      {moment.hidden && (
        <span className="absolute top-1 right-1 z-10 p-1 bg-[#0d0d0d]/80 border border-[#2a2a2a]">
          <EyeOff size={9} className="text-[#555]" />
        </span>
      )}
      {isVideo && meta.animation_url ? (
        <MomentVideo
          src={meta.animation_url}
          poster={meta.image}
          thumbhash={meta.kismet_thumbhash}
          showPosterLayer
          className="w-full h-full object-contain"
        />
      ) : meta.image && !imgError ? (
        <MomentImage
          src={meta.image}
          alt={meta.name ?? 'moment'}
          fill
          className="object-contain transition-transform duration-500 group-hover/tile:scale-105"
          onAllError={() => setImgError(true)}
          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 18vw, 12vw"
          mime={meta.content?.mime}
          thumbhash={meta.kismet_thumbhash}
          priority={priority}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <span className="text-[#2a2a2a] font-mono text-[10px]">no preview</span>
        </div>
      )}
      {meta.name && (
        <span
          className="absolute inset-x-0 bottom-0 px-1.5 py-1 text-[10px] font-mono text-[#efefef] bg-gradient-to-t from-[#0d0d0d]/95 to-transparent opacity-0 group-hover/tile:opacity-100 transition-opacity truncate"
        >
          {meta.name}
        </span>
      )}
    </Link>
  )
}

