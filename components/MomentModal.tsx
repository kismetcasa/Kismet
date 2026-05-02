'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { X, Star, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import {
  resolveUri, formatPrice, shortAddress, formatRelativeTime,
  type Moment, type MomentDetail, type MomentComment,
} from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ListButton } from './ListButton'
import { ProfileAvatar } from './ProfileAvatar'
import { useAdmin } from '@/contexts/AdminContext'

const TOP_COMMENTS = 3

interface MomentModalProps {
  moment: Moment
  onClose: () => void
  // Props pre-populated by MomentCard to avoid redundant fetches
  initialPrice?: string
  initialMaxSupply?: number | null
  initialCreatorName?: string
  initialCreatorAvatar?: string
  initialOwnedBalance?: number
}

export function MomentModal({
  moment,
  onClose,
  initialPrice,
  initialMaxSupply,
  initialCreatorName,
  initialCreatorAvatar,
  initialOwnedBalance,
}: MomentModalProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collected, setCollected] = useState(false)
  const [creatorName, setCreatorName] = useState(
    () => initialCreatorName ?? shortAddress(moment.creator.address),
  )
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(initialCreatorAvatar)
  const [comments, setComments] = useState<MomentComment[]>(
    () => getCachedComments(moment.address, moment.token_id) ?? []
  )
  const [commentsLoading, setCommentsLoading] = useState(
    () => getCachedComments(moment.address, moment.token_id) === undefined
  )
  const [showAllComments, setShowAllComments] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
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

  // Only query on-chain balance when card didn't pass it in
  const { data: ownedBalance } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    query: { enabled: !!connectedAddress && initialOwnedBalance === undefined },
  })
  const alreadyOwned =
    initialOwnedBalance !== undefined
      ? initialOwnedBalance > 0
      : ownedBalance
        ? Number(ownedBalance) > 0
        : false

  // Derived price and supply — prefer passed-in values, fall back to fetched detail
  const price = initialPrice ?? (detail ? formatPrice(detail.saleConfig.pricePerToken) : null)
  const displayMaxSupply: number | null | undefined =
    initialMaxSupply !== undefined
      ? initialMaxSupply
      : detail
        ? (detail.maxSupply ?? null)
        : undefined

  // Fetch moment detail only when card didn't pass price/supply
  useEffect(() => {
    if (initialPrice !== undefined && initialMaxSupply !== undefined) return
    const cached = getCachedDetail(moment.address, moment.token_id)
    if (cached) { setDetail(cached); return }
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) { setCachedDetail(moment.address, moment.token_id, d); setDetail(d) } })
      .catch(() => {})
  }, [moment.address, moment.token_id, initialPrice, initialMaxSupply])

  // Fetch creator profile via shared cache (cache hit if card already resolved it)
  useEffect(() => {
    fetchCreatorProfile(creatorAddress).then(({ name, avatarUrl }) => {
      setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [creatorAddress])

  // Fetch comments with shared cache — survives modal close/reopen and seeds detail page
  const fetchComments = useCallback(async () => {
    if (!commentsLoading) return
    const cached = getCachedComments(moment.address, moment.token_id)
    if (cached) { setComments(cached); setCommentsLoading(false); return }
    try {
      const params = new URLSearchParams({
        collectionAddress: moment.address,
        tokenId: moment.token_id,
        chainId: '8453',
      })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        const fetched = data.comments ?? []
        setCachedComments(moment.address, moment.token_id, fetched)
        setComments(fetched)
      }
    } catch {
      // non-critical
    } finally {
      setCommentsLoading(false)
    }
  }, [moment.address, moment.token_id])

  useEffect(() => { fetchComments() }, [fetchComments])

  // Measure description overflow once after mount (element is clamped at that point)
  useEffect(() => {
    const el = descRef.current
    if (!el) return
    setDescOverflows(el.scrollHeight > el.clientHeight)
  }, [])

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

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${moment.address}/${moment.token_id}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

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

  const visibleComments = showAllComments ? comments : comments.slice(0, TOP_COMMENTS)
  const hiddenCount = comments.length - TOP_COMMENTS

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="relative w-full max-w-3xl bg-[#161616] border border-[#2a2a2a] flex flex-col md:grid md:grid-cols-2 max-h-[90vh] overflow-y-auto md:overflow-hidden">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-20 p-1 text-[#555] hover:text-[#888] transition-colors"
        >
          <X size={16} />
        </button>

        {/* Left: media — click navigates to detail page */}
        <div className="relative aspect-square bg-[#111] flex-shrink-0 border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a]">
          {isAdmin && (
            <button
              onClick={() => toggleFeatured(moment.address, moment.token_id)}
              className={`absolute top-2 left-2 z-20 p-1 transition-colors ${
                isFeatured ? 'text-yellow-400' : 'text-[#333] hover:text-[#888]'
              }`}
              title={isFeatured ? 'Unfeature' : 'Feature'}
            >
              <Star size={16} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
            </button>
          )}
          <Link
            href={`/moment/${moment.address}/${moment.token_id}`}
            onClick={onClose}
            className="absolute inset-0 z-10 cursor-pointer"
          />
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
            {/* Title + copy link */}
            <div className="flex items-start gap-2 pr-6">
              <h2 className="text-sm font-mono text-[#efefef] leading-snug flex-1 min-w-0">
                {meta.name ?? `#${moment.token_id}`}
              </h2>
              <button
                onClick={handleCopyLink}
                title="copy link"
                className="flex-shrink-0 mt-0.5 text-[#444] hover:text-[#888] transition-colors"
              >
                {linkCopied ? <Check size={11} className="text-[#6ee7b7]" /> : <Copy size={11} />}
              </button>
            </div>

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
                <p
                  ref={descRef}
                  className={`text-xs font-mono text-[#888] leading-relaxed ${showFullDesc ? '' : 'line-clamp-2'}`}
                >
                  {meta.description}
                </p>
                {(descOverflows || showFullDesc) && (
                  <button
                    onClick={() => setShowFullDesc(v => !v)}
                    className="flex items-center gap-1 text-[10px] font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
                  >
                    {showFullDesc ? <><ChevronUp size={10} /> show less</> : <><ChevronDown size={10} /> show more</>}
                  </button>
                )}
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
          <div className="px-5 pb-2 flex flex-col gap-1.5 sm:flex-row sm:gap-2 sm:items-stretch">
            {alreadyOwned && (
              <div className="w-full sm:flex-none sm:w-1/3">
                <ListButton
                  collectionAddress={moment.address}
                  tokenId={moment.token_id}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                  buttonClassName="h-auto sm:h-full"
                />
              </div>
            )}
            <div className={`flex ${alreadyOwned ? 'w-full sm:flex-1' : 'flex-1'} border transition-colors ${
              alreadyOwned || collected ? 'border-[#8B5CF6]' : 'border-[#2a2a2a]'
            }`}>
              <button
                onClick={handleCollect}
                disabled={collecting || alreadyOwned || collected}
                className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase transition-all disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
                  collected || alreadyOwned ? 'text-[#8B5CF6] bg-[#8B5CF6]/10' : 'text-[#555] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white'
                }`}
              >
                {collecting ? 'collecting…' : (collected || alreadyOwned) ? 'collected' : 'collect'}
              </button>
              <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono text-[#444]">
                  {displayMaxSupply === undefined
                    ? '…'
                    : displayMaxSupply === null || displayMaxSupply === 0
                      ? 'open'
                      : displayMaxSupply.toLocaleString()}
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
