'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { formatEther } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { resolveUri, shortAddress, type Moment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { MAX_COLLECT_ALL_BATCH } from '@/lib/zoraMint'
import { useCollectAll } from '@/hooks/useCollectAll'
import { MomentCard } from './MomentCard'

export interface FeaturedCollectionRow {
  contractAddress: string
  name?: string
  metadata?: { name?: string; image?: string; description?: string }
  default_admin?: { address?: string; username?: string }
  moments: Moment[]
  ethEligibleTokenIds: string[]
  ethEligibleTotalWei: string
  featuredAt: number
}

interface CollectionRowProps {
  collection: FeaturedCollectionRow
  // Replaces the default cost-preview + collect-all action block. Most
  // callers leave this undefined and get the canonical bulk-collect UX.
  primaryAction?: React.ReactNode
}

// Trim a wei value's formatted ether string to ≤4 decimal places, dropping
// trailing zeroes. Keeps the cost chip narrow without lying about precision.
function formatEthChip(wei: bigint): string {
  const full = formatEther(wei)
  if (!full.includes('.')) return full
  const [whole, frac] = full.split('.')
  const trimmed = frac.slice(0, 4).replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : whole
}

export function CollectionRow({ collection, primaryAction }: CollectionRowProps) {
  const c = collection
  const imgUrl = c.metadata?.image ? resolveUri(c.metadata.image) : null
  const name = c.metadata?.name || c.name || shortAddress(c.contractAddress)
  const description = c.metadata?.description

  const adminAddr = c.default_admin?.address
  const initialUsername = c.default_admin?.username
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
            {primaryAction ?? <DefaultCollectAllAction collection={c} />}
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

// Cost-preview + collect-all button. Hidden when nothing's ETH-eligible (e.g.,
// USDC-only collections); we don't surface a partial CTA there.
function DefaultCollectAllAction({ collection }: { collection: FeaturedCollectionRow }) {
  const eligibleCount = collection.ethEligibleTokenIds.length
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collectAll, status } = useCollectAll()

  if (eligibleCount === 0) return null

  const inFlight = status !== 'idle' && status !== 'done' && status !== 'error'
  const batchSize = Math.min(eligibleCount, MAX_COLLECT_ALL_BATCH)
  const totalWei = BigInt(collection.ethEligibleTotalWei)
  const costLabel = totalWei > 0n ? `Ξ ${formatEthChip(totalWei)}` : 'free'

  function handleClick() {
    if (!isConnected) {
      openConnectModal?.()
      return
    }
    collectAll({
      collectionAddress: collection.contractAddress as `0x${string}`,
      candidateTokenIds: collection.ethEligibleTokenIds,
    })
  }

  const label = inFlight
    ? statusLabel(status)
    : `collect all (${batchSize}${eligibleCount > MAX_COLLECT_ALL_BATCH ? ` of ${eligibleCount}` : ''})`

  return (
    <div className="flex items-stretch gap-1.5">
      <span className="px-2 py-1.5 text-xs font-mono border border-[#2a2a2a] text-[#888] whitespace-nowrap">
        {costLabel}
      </span>
      <button
        onClick={handleClick}
        disabled={inFlight}
        className="flex-1 py-1.5 text-xs font-mono border border-[#8B5CF6]/40 text-[#8B5CF6] hover:border-[#8B5CF6] hover:bg-[#8B5CF6]/10 transition-colors disabled:opacity-60 disabled:cursor-wait"
      >
        {label}
      </button>
    </div>
  )
}

function statusLabel(status: ReturnType<typeof useCollectAll>['status']): string {
  switch (status) {
    case 'preparing':
      return 'preparing…'
    case 'minting':
      return 'confirm in wallet…'
    case 'confirming':
      return 'confirming…'
    case 'recording':
      return 'finalizing…'
    default:
      return 'collecting…'
  }
}
