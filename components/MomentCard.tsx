'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { Star } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { resolveUri, formatPrice, shortAddress, type Moment, type MomentDetail } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'
import { ERC1155_ABI } from '@/lib/seaport'
import { ListButton } from './ListButton'
import { MomentModal } from './MomentModal'

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
  const [maxSupply, setMaxSupply] = useState<number | undefined>(undefined)
  const [creatorName, setCreatorName] = useState(() => shortAddress(moment.creator.address))
  const [modalOpen, setModalOpen] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [collected, setCollected] = useState(false)
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()

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

  // Fetch sale config for price + supply display
  useEffect(() => {
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => r.ok ? r.json() as Promise<MomentDetail> : Promise.reject())
      .then((detail) => {
        setPrice(formatPrice(detail.saleConfig.pricePerToken))
        setMaxSupply(detail.maxSupply)
      })
      .catch(() => {})
  }, [moment.address, moment.token_id])

  async function handleCollect() {
    if (!isConnected || !connectedAddress) { openConnectModal?.(); return }
    setCollecting(true)
    try {
      const res = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moment: { collectionAddress: moment.address, tokenId: moment.token_id, chainId: 8453 },
          amount: 1,
          comment: 'collected via Kismet Art',
          account: connectedAddress,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Collect failed')
      setCollected(true)
      toast.success('Collected!')
    } catch (err) {
      toast.error('Collect failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setCollecting(false)
    }
  }

  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  const supplyLabel = maxSupply === undefined ? '…' : (maxSupply === 0 ? 'open' : maxSupply.toLocaleString())

  return (
    <>
      <article className="group flex flex-col bg-[#161616] border border-[#2a2a2a] overflow-hidden">
        {/* Media — click opens modal */}
        <div
          onClick={() => setModalOpen(true)}
          className="cursor-pointer relative aspect-square bg-[#111] overflow-hidden"
        >
          {owned > 0 && (
            <span className="absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-[#0d0d0d]/80 border border-[#2a2a2a] text-[#efefef] font-mono text-[10px] leading-tight">
              ×{owned}
            </span>
          )}
          {isAdmin && (
            <button
              onClick={(e) => {
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
        </div>

        {/* Info — click navigates to detail page */}
        <Link
          href={`/moment/${moment.address}/${moment.token_id}`}
          className="px-4 pt-4 pb-3 flex flex-col gap-1.5"
        >
          <h3 className="text-sm text-[#efefef] font-mono truncate hover:text-[#bbb] transition-colors">
            {meta.name ?? `#${moment.token_id}`}
          </h3>
          {meta.description && (
            <p className="text-xs font-mono text-[#888] line-clamp-2 leading-relaxed">
              {meta.description}
            </p>
          )}
          <span
            className="text-xs text-[#555] font-mono hover:text-[#888] transition-colors w-fit"
            title={moment.creator.address}
          >
            by {creatorName}
          </span>
        </Link>

        {/* Actions — list (if owned) + collect + price/supply */}
        <div className="px-4 pb-4 flex">
          {owned > 0 && (
            <div className="flex-1">
              <ListButton
                collectionAddress={moment.address}
                tokenId={moment.token_id}
                name={meta.name}
                image={meta.image ? resolveUri(meta.image) : undefined}
                creatorAddress={moment.creator?.address}
              />
            </div>
          )}
          <div className={`flex ${owned > 0 ? 'flex-1 -ml-px' : 'w-full'} border transition-colors ${
            collected ? 'border-[#8B5CF6]' : 'border-[#2a2a2a]'
          }`}>
            <button
              onClick={handleCollect}
              disabled={collecting || collected}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                collected ? 'text-[#8B5CF6] bg-[#8B5CF6]/10' : 'text-[#555] hover:text-[#8B5CF6]'
              }`}
            >
              {collecting ? 'collecting…' : collected ? 'collected' : 'collect'}
            </button>
            <div className="border-l border-[#2a2a2a] px-2 py-1.5 flex flex-col items-end justify-between min-w-[3.5rem]">
              <span className="text-[9px] font-mono accent-grad">{price ?? '…'}</span>
              <span className="text-[9px] font-mono text-[#444]">{supplyLabel}</span>
            </div>
          </div>
        </div>
      </article>

      {modalOpen && (
        <MomentModal moment={moment} onClose={() => setModalOpen(false)} />
      )}
    </>
  )
}
