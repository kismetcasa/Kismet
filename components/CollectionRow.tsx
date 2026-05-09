'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { resolveUri, shortAddress, type Moment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { OPERATOR_SMART_WALLET } from '@/lib/config'
import { MomentCard } from './MomentCard'
import { CollectAllAction } from './CollectAllAction'

export interface FeaturedCollectionRow {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string }
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
  // Replaces the default cost-preview + collect-all action block. Most
  // callers leave this undefined and get the canonical bulk-collect UX.
  primaryAction?: React.ReactNode
}

export function CollectionRow({ collection, primaryAction }: CollectionRowProps) {
  const c = collection
  const imgUrl = c.metadata?.image ? resolveUri(c.metadata.image) : null
  const name = c.metadata?.name || c.name || shortAddress(c.contractAddress)
  const description = c.metadata?.description

  const rawAdminAddr = c.default_admin?.address
  // `default_admin` from inprocess can be the platform operator smart
  // wallet for collections deployed on behalf of an artist. That wallet
  // has no Kismet profile, so linking to it sends visitors to an empty
  // page. Suppress the chip entirely in that case rather than render a
  // dead link — the plural endpoint doesn't surface the artist EOA on
  // these rows, so there's no better label to fall back to here.
  const isOperatorAdmin =
    !!rawAdminAddr &&
    !!OPERATOR_SMART_WALLET &&
    rawAdminAddr.toLowerCase() === OPERATOR_SMART_WALLET.toLowerCase()
  const adminAddr = isOperatorAdmin ? undefined : rawAdminAddr
  const initialUsername = isOperatorAdmin ? undefined : c.default_admin?.username
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
          {imgUrl ? (
            <Image
              src={imgUrl}
              alt={name}
              fill
              className="object-contain transition-transform duration-500 group-hover/img:scale-105"
              sizes="(max-width: 768px) 100vw, 41vw"
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
            {primaryAction ?? (
              <CollectAllAction
                collectionAddress={c.contractAddress}
                ethEligibleTokenIds={c.ethEligibleTokenIds}
                ethEligibleTotalWei={c.ethEligibleTotalWei}
                usdcEligibleTokenIds={c.usdcEligibleTokenIds}
                usdcEligibleTotalUsdc={c.usdcEligibleTotalUsdc}
              />
            )}
          </div>
        </div>
      </div>

      {/* Horizontal scroll mints. md+ takes 7/12. Mobile shows ~80% width
          per card so the next card peeks as a swipe affordance. */}
      <div className="md:col-span-7 flex overflow-x-auto snap-x snap-mandatory gap-3 p-3 [-webkit-overflow-scrolling:touch]">
        {c.moments.length === 0 ? (
          <div className="flex-1 flex items-center justify-center min-h-[200px]">
            <span className="text-xs font-mono text-[#555]">no moments yet</span>
          </div>
        ) : (
          c.moments.map((m) => (
            <div
              key={m.id || `${m.address}-${m.token_id}`}
              className="snap-start flex-shrink-0 w-[80%] md:w-[calc(33.333%-0.5rem)]"
            >
              <MomentCard moment={m} hidePriceSupply />
            </div>
          ))
        )}
      </div>
    </article>
  )
}

