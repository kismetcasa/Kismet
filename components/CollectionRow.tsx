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
    // Two layouts share one tree:
    //   mobile (<sm): flex-row — cover on the left, mints scroll horizontally
    //     to the right. Single row, no info section. Curator's call: keeps
    //     featured rows compact in the feed instead of a tall vertical block.
    //   sm+: block — header (cover + info) on top, mints grid below.
    // The SharedVideoProvider clips video elements to their scrollable
    // ancestor's bounds (see clip-path in positionElement), so the
    // horizontal scroller doesn't leak videos past the article edge.
    <article className="flex sm:block border border-[#2a2a2a] bg-[#161616] overflow-hidden">
      <div className="flex-shrink-0 sm:flex sm:flex-row sm:gap-4 sm:p-4 sm:border-b sm:border-[#2a2a2a]">
        <Link
          href={`/collection/${c.contractAddress}`}
          className="relative aspect-square w-32 sm:w-40 md:w-48 flex-shrink-0 block overflow-hidden bg-[#111] group/img"
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
              sizes="(max-width: 640px) 128px, 192px"
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
          {/* Mobile-only name overlay: the sm+ info section is hidden,
              so the collection still needs a label inside the row. */}
          <span className="sm:hidden absolute inset-x-0 bottom-0 px-2 py-1 text-[10px] font-mono text-[#efefef] bg-gradient-to-t from-[#0d0d0d]/95 to-transparent truncate">
            {name}
          </span>
        </Link>

        <div className="hidden sm:flex flex-col gap-1 min-w-0 flex-1">
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

      {/* Mints: up to 20 in chronological order (oldest → newest, left to
          right). Single switch between horizontal scroller and grid via
          responsive classes — sm+ wins, mobile defaults apply below it. */}
      <div className="flex-1 min-w-0 overflow-x-auto flex gap-2 p-2 snap-x snap-mandatory [-webkit-overflow-scrolling:touch] sm:flex-none sm:overflow-visible sm:grid sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-10 sm:gap-2 sm:p-3 sm:snap-none">
        {c.moments.length === 0 ? (
          <div className="flex-1 sm:col-span-full flex items-center justify-center min-h-[160px] sm:min-h-[200px]">
            <span className="text-xs font-mono text-[#555]">no moments yet</span>
          </div>
        ) : (
          c.moments.map((m, idx) => (
            <div
              key={m.id || `${m.address}-${m.token_id}`}
              className="w-32 flex-shrink-0 snap-start sm:w-auto sm:flex-shrink"
            >
              <MomentCard moment={m} compact priority={priority && idx === 0} />
            </div>
          ))
        )}
      </div>
    </article>
  )
}
