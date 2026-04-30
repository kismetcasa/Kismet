'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Star } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { CollectButton } from './CollectButton'
import { ListButton } from './ListButton'
import { resolveUri, formatPrice, shortAddress, type Moment, type MomentDetail } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'
import { ERC1155_ABI } from '@/lib/seaport'

// Module-level cache — deduplicates profile fetches across all mounted cards
const profileCache = new Map<string, { name: string; ts: number }>()
const CACHE_TTL = 5 * 60 * 1000

async function fetchCreatorName(address: string): Promise<string> {
  const cached = profileCache.get(address)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.name
  try {
    const res = await fetch(`/api/profile/${address}`)
    const d = await res.json()
    const name: string = d.profile?.username || d.profile?.ensName || shortAddress(address)
    profileCache.set(address, { name, ts: Date.now() })
    return name
  } catch {
    return shortAddress(address)
  }
}

interface MomentCardProps {
  moment: Moment
}

export function MomentCard({ moment }: MomentCardProps) {
  const [imgError, setImgError] = useState(false)
  const [price, setPrice] = useState<string | null>(null)
  const [creatorName, setCreatorName] = useState(() => shortAddress(moment.creator.address))
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const { address: connectedAddress } = useAccount()

  useEffect(() => {
    fetchCreatorName(moment.creator.address).then(setCreatorName)
  }, [moment.creator.address])
  const { data: ownedBalance } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const owned = ownedBalance ? Number(ownedBalance) : 0

  const meta = moment.metadata ?? {}
  const isFeatured = featuredKeys.has(`${moment.address.toLowerCase()}:${moment.token_id}`)

  // Fetch sale config for price display
  useEffect(() => {
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => r.ok ? r.json() as Promise<MomentDetail> : Promise.reject())
      .then((detail) => setPrice(formatPrice(detail.saleConfig.pricePerToken)))
      .catch(() => {})
  }, [moment.address, moment.token_id])

  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')

  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl

  return (
    <article className="group flex flex-col bg-[#161616] border border-[#2a2a2a] overflow-hidden">
      {/* Media — clickable to detail page */}
      <Link href={`/moment/${moment.address}/${moment.token_id}`} className="block relative aspect-square bg-[#111] overflow-hidden">
        {owned > 0 && (
          <span className="absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-[#0d0d0d]/80 border border-[#2a2a2a] text-[#efefef] font-mono text-[10px] leading-tight">
            ×{owned}
          </span>
        )}
        {isAdmin && (
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              toggleFeatured(moment.address, moment.token_id)
            }}
            className={`absolute top-2 right-2 z-10 p-1 transition-colors ${
              isFeatured ? 'text-yellow-400' : 'text-[#333] hover:text-[#888]'
            }`}
            title={isFeatured ? 'Unfeature' : 'Feature'}
          >
            <Star size={16} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
          </button>
        )}
        {isVideo && mediaUrl ? (
          <video
            src={mediaUrl}
            className="w-full h-full object-cover"
            autoPlay
            muted
            loop
            playsInline
          />
        ) : imageUrl && !imgError ? (
          <Image
            src={imageUrl}
            alt={meta.name ?? 'moment'}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            onError={() => setImgError(true)}
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
          </div>
        )}
      </Link>

      {/* Info */}
      <div className="p-4 flex flex-col gap-3">
        <div>
          <Link
            href={`/moment/${moment.address}/${moment.token_id}`}
            className="block"
          >
            <h3 className="text-sm text-[#efefef] font-mono truncate hover:text-[#bbb] transition-colors">
              {meta.name ?? `#${moment.token_id}`}
            </h3>
          </Link>
          {meta.description && (
            <p className="text-xs text-[#888] mt-1 line-clamp-2 leading-relaxed">
              {meta.description}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Link
              href={`/profile/${moment.creator.address}`}
              className="text-xs text-[#555] font-mono hover:text-[#888] transition-colors"
              title={moment.creator.address}
            >
              by {creatorName}
            </Link>
            {price !== null && (
              <span className="text-xs font-mono accent-grad">{price}</span>
            )}
          </div>

          <CollectButton
            collectionAddress={moment.address}
            tokenId={moment.token_id}
          />
        </div>
        <ListButton
          collectionAddress={moment.address}
          tokenId={moment.token_id}
          name={meta.name}
          image={meta.image ? resolveUri(meta.image) : undefined}
          creatorAddress={moment.creator?.address}
        />
      </div>
    </article>
  )
}
