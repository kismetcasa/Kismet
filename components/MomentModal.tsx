'use client'

import { useState, useEffect, useCallback } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { X, Star, ChevronDown, ChevronUp } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import {
  resolveUri, formatPrice, shortAddress,
  type Moment, type MomentDetail, type MomentComment,
} from '@/lib/inprocess'
import { ERC1155_ABI } from '@/lib/seaport'
import { ListButton } from './ListButton'
import { ProfileAvatar } from './ProfileAvatar'
import { useAdmin } from '@/contexts/AdminContext'

const TOP_COMMENTS = 3

function formatRelativeTime(timestamp: number): string {
  const secs = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp
  const diff = Math.floor(Date.now() / 1000) - secs
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

interface MomentModalProps {
  moment: Moment
  onClose: () => void
}

export function MomentModal({ moment, onClose }: MomentModalProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collected, setCollected] = useState(false)
  const [creatorName, setCreatorName] = useState(() => shortAddress(moment.creator.address))
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [comments, setComments] = useState<MomentComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [showAllComments, setShowAllComments] = useState(false)
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()

  const meta = moment.metadata ?? {}
  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  const creatorAddress = moment.creator.address
  const isFeatured = featuredKeys.has(`${moment.address.toLowerCase()}:${moment.token_id}`)

  const { data: ownedBalance } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const alreadyOwned = ownedBalance ? Number(ownedBalance) > 0 : false

  // Fetch moment detail (price)
  useEffect(() => {
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setDetail(d))
      .catch(() => {})
  }, [moment.address, moment.token_id])

  // Fetch creator profile
  useEffect(() => {
    fetch(`/api/profile/${creatorAddress}`)
      .then((r) => r.json())
      .then((d) => {
        setCreatorName(d.profile?.username || d.profile?.ensName || shortAddress(creatorAddress))
        setCreatorAvatar(d.profile?.avatarUrl)
      })
      .catch(() => {})
  }, [creatorAddress])

  // Fetch comments
  const fetchComments = useCallback(async () => {
    setCommentsLoading(true)
    try {
      const params = new URLSearchParams({
        collectionAddress: moment.address,
        tokenId: moment.token_id,
        chainId: '8453',
      })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        setComments(data.comments ?? [])
      }
    } catch {
      // non-critical
    } finally {
      setCommentsLoading(false)
    }
  }, [moment.address, moment.token_id])

  useEffect(() => { fetchComments() }, [fetchComments])

  // Lock body scroll while open
  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

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

  const price = detail ? formatPrice(detail.saleConfig.pricePerToken) : null
  const visibleComments = showAllComments ? comments : comments.slice(0, TOP_COMMENTS)
  const hiddenCount = comments.length - TOP_COMMENTS

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-3xl bg-[#161616] border border-[#2a2a2a] flex flex-col md:grid md:grid-cols-2 max-h-[90vh] overflow-hidden">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-20 p-1 text-[#555] hover:text-[#888] transition-colors"
        >
          <X size={16} />
        </button>

        {/* Left: media */}
        <div className="relative aspect-square bg-[#111] flex-shrink-0 border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a]">
          {isAdmin && (
            <button
              onClick={() => toggleFeatured(moment.address, moment.token_id)}
              className={`absolute top-2 left-2 z-10 p-1 transition-colors ${
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
              autoPlay muted loop playsInline
              poster={imageUrl ?? undefined}
            />
          ) : imageUrl ? (
            <Image
              src={imageUrl}
              alt={meta.name ?? 'moment'}
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 50vw"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
            </div>
          )}
        </div>

        {/* Right: info — scrolls within grid cell */}
        <div className="flex flex-col md:min-h-0 md:overflow-y-auto">

          <div className="px-5 py-4 flex flex-col gap-3">
            {/* Title */}
            <h2 className="text-sm font-mono text-[#efefef] leading-snug pr-6">
              {meta.name ?? `#${moment.token_id}`}
            </h2>

            {/* Creator */}
            <Link
              href={`/profile/${creatorAddress}`}
              onClick={onClose}
              className="flex items-center gap-2 group w-fit"
            >
              <ProfileAvatar address={creatorAddress} avatarUrl={creatorAvatar} size={20} />
              <span className="text-xs font-mono text-[#555] group-hover:text-[#888] transition-colors">
                {creatorName}
              </span>
            </Link>

            {/* Description */}
            {meta.description && (
              <div className="flex flex-col gap-1">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">description</p>
                <p className="text-xs font-mono text-[#888] leading-relaxed line-clamp-4">
                  {meta.description}
                </p>
              </div>
            )}

            {/* Comments */}
            {!commentsLoading && comments.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">comments</p>
                {visibleComments.map((c, i) => (
                  <div key={i} className="flex gap-2 items-baseline">
                    <span className="text-[11px] font-mono text-[#555] flex-shrink-0">
                      {shortAddress(c.sender)}
                    </span>
                    <span className="text-xs font-mono text-[#888] flex-1 break-words leading-relaxed">
                      {c.comment}
                    </span>
                    <span className="text-[10px] font-mono text-[#333] flex-shrink-0">
                      {formatRelativeTime(c.timestamp)}
                    </span>
                  </div>
                ))}
                {hiddenCount > 0 && (
                  <button
                    onClick={() => setShowAllComments((v) => !v)}
                    className="flex items-center gap-1 text-[10px] font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
                  >
                    {showAllComments
                      ? <><ChevronUp size={10} /> show less</>
                      : <><ChevronDown size={10} /> {hiddenCount} more</>}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1 min-h-4" />

          {/* Collect row — list to the left when owned */}
          <div className="px-5 pb-2 flex gap-2 items-stretch">
            {alreadyOwned && (
              <div className="w-1/4 flex-shrink-0">
                <ListButton
                  collectionAddress={moment.address}
                  tokenId={moment.token_id}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                  buttonClassName="h-full"
                />
              </div>
            )}
            <div className={`flex flex-1 border transition-colors ${
              alreadyOwned ? 'border-[#8B5CF6] border-l-[#2a2a2a]' : collected ? 'border-[#8B5CF6]' : 'border-[#2a2a2a]'
            }`}>
              <button
                onClick={handleCollect}
                disabled={collecting || alreadyOwned || collected}
                className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                  collected || alreadyOwned ? 'text-[#8B5CF6] bg-[#8B5CF6]/10' : 'text-[#555] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white'
                }`}
              >
                {collecting ? 'collecting…' : (collected || alreadyOwned) ? 'collected' : 'collect'}
              </button>
              <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono text-[#444]">
                  {detail === null ? '…' : (detail.maxSupply ? detail.maxSupply.toLocaleString() : 'open')}
                </span>
              </div>
              <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
            </div>
          </div>

          {/* View page — hugs bottom */}
          <div className="px-5 pb-5">
            <Link
              href={`/moment/${moment.address}/${moment.token_id}`}
              onClick={onClose}
              className="w-full flex items-center justify-center text-xs font-mono tracking-wider uppercase border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors py-2.5"
            >
              view page →
            </Link>
          </div>

        </div>
      </div>
    </div>
  )
}
