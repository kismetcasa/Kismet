'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X } from 'lucide-react'
import { resolveUri, formatPrice, shortAddress, formatRelativeTime, DEFAULT_COLLECT_COMMENT, type MomentDetail, type MomentComment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ListButton } from './ListButton'
import { ProfileAvatar } from './ProfileAvatar'
import { useAdmin } from '@/contexts/AdminContext'

interface Props {
  address: string
  tokenId: string
  initialDetail?: MomentDetail | null
}

const TOP_COMMENTS = 3

export function MomentDetailView({ address, tokenId, initialDetail }: Props) {
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()

  const [detail, setDetail] = useState<MomentDetail | null>(initialDetail ?? null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [comments, setComments] = useState<MomentComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [showAllComments, setShowAllComments] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [collected, setCollected] = useState(false)
  const [creatorName, setCreatorName] = useState('')
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [linkCopied, setLinkCopied] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
  const [hasSplits, setHasSplits] = useState(false)
  const [splitAddress, setSplitAddress] = useState('')
  const [distributing, setDistributing] = useState(false)
  const [distributeHash, setDistributeHash] = useState<string | null>(null)

  const { data: ownedBalance } = useReadContract({
    address: address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(tokenId)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const alreadyOwned = ownedBalance ? Number(ownedBalance) > 0 : false

  const isFeatured = featuredKeys.has(`${address.toLowerCase()}:${tokenId}`)
  const creatorAddress = detail?.momentAdmins[0] ?? ''
  const isCreator =
    !!connectedAddress &&
    !!creatorAddress &&
    connectedAddress.toLowerCase() === creatorAddress.toLowerCase()

  // Fetch moment detail (skip if pre-populated from server)
  useEffect(() => {
    if (initialDetail !== undefined) return
    const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setDetail(d))
      .catch(() => {})
  }, [address, tokenId, initialDetail])

  // Fetch text content for writing moments
  useEffect(() => {
    if (!detail) return
    const { content } = detail.metadata ?? {}
    if (content?.mime !== 'text/plain' || !content?.uri) return
    fetch(resolveUri(content.uri))
      .then((r) => r.text())
      .then(setTextContent)
      .catch(() => {})
  }, [detail])

  // Fetch creator profile via shared cache
  useEffect(() => {
    if (!creatorAddress) return
    fetchCreatorProfile(creatorAddress).then(({ name, avatarUrl }) => {
      setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [creatorAddress])

  // Fetch comments
  const fetchComments = useCallback(async () => {
    setCommentsLoading(true)
    try {
      const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        setComments(data.comments ?? [])
      }
    } catch {
      // comments are non-critical
    } finally {
      setCommentsLoading(false)
    }
  }, [address, tokenId])

  useEffect(() => { fetchComments() }, [fetchComments])

  useEffect(() => {
    const el = descRef.current
    if (!el) return
    setDescOverflows(el.scrollHeight > el.clientHeight)
  }, [detail])

  useEffect(() => {
    if (!lightboxOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxOpen])

  // Check splits flag (only for creator)
  useEffect(() => {
    if (!isCreator) return
    fetch(`/api/moment/splits?collectionAddress=${address}&tokenId=${tokenId}`)
      .then((r) => r.json())
      .then((d) => setHasSplits(d.hasSplits === true))
      .catch(() => {})
  }, [address, tokenId, isCreator])

  async function handleCollect() {
    if (!isConnected || !connectedAddress) { openConnectModal?.(); return }
    setCollecting(true)
    try {
      const res = await fetch('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          moment: { collectionAddress: address, tokenId, chainId: 8453 },
          amount: 1,
          comment: commentText.trim() || DEFAULT_COLLECT_COMMENT,
          account: connectedAddress,
          pricePerToken: detail?.saleConfig.pricePerToken,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Collect failed')
      setCollected(true)
      setCommentText('')
      toast.success('Collected!')
      setTimeout(fetchComments, 3000)
    } catch (err) {
      toast.error('Collect failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setCollecting(false)
    }
  }

  async function handleDistribute() {
    const addr = splitAddress.trim()
    if (!addr || !isAddress(addr)) { toast.error('Invalid split address'); return }
    setDistributing(true)
    try {
      const res = await fetch('/api/distribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splitAddress: addr, chainId: 8453 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Distribution failed')
      setDistributeHash(data.hash)
      toast.success('Distributed!')
    } catch (err) {
      toast.error('Distribution failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setDistributing(false)
    }
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${address}/${tokenId}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  const meta = detail?.metadata ?? {}
  const isTextMoment = meta.content?.mime === 'text/plain'
  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  const price = detail ? formatPrice(detail.saleConfig.pricePerToken) : null

  const visibleComments = showAllComments ? comments : comments.slice(0, TOP_COMMENTS)
  const hiddenCount = comments.length - TOP_COMMENTS

  return (
    <div className="max-w-5xl mx-auto pb-16">

      {/* Back nav */}
      <div className="px-4 py-3 border-b border-[#2a2a2a]">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
        >
          <ArrowLeft size={12} />
          back
        </Link>
      </div>

      {/* Two-column on desktop, stacked on mobile */}
      <div className="md:grid md:grid-cols-2 border-b border-[#2a2a2a]">

        {/* Left: media — sticky on desktop */}
        <div className="border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a] md:sticky md:top-14">
          {isTextMoment ? (
            <div className="min-h-64 flex items-start p-6 sm:p-10 bg-[#111]">
              <p className="text-sm font-mono text-[#efefef] leading-relaxed whitespace-pre-wrap">
                {textContent ?? (detail ? '' : '…')}
              </p>
            </div>
          ) : (
            <div
              className={`relative aspect-square bg-[#111] ${(imageUrl || (isVideo && mediaUrl)) ? 'cursor-zoom-in' : ''}`}
              onClick={() => { if (imageUrl || (isVideo && mediaUrl)) setLightboxOpen(true) }}
            >
              {isVideo && mediaUrl ? (
                <video
                  src={mediaUrl}
                  className="w-full h-full object-cover"
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : imageUrl ? (
                <Image
                  src={imageUrl}
                  alt={meta.name ?? 'moment'}
                  fill
                  className="object-cover"
                  sizes="(max-width: 768px) 100vw, 50vw"
                  priority
                />
              ) : !detail ? (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-[#333] font-mono text-xs">loading…</span>
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details — scrolls within grid cell on desktop */}
        <div className="flex flex-col md:min-h-0 md:overflow-y-auto">

          {/* Info: title, creator, description, comments, textarea */}
          <div className="px-5 py-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-sm font-mono text-[#efefef] leading-snug">
                {meta.name ?? `#${tokenId}`}
              </h1>
              <button
                onClick={handleCopyLink}
                className="flex items-center gap-1 text-xs font-mono text-[#555] hover:text-[#888] transition-colors flex-shrink-0"
              >
                {linkCopied ? <Check size={11} className="text-[#6ee7b7]" /> : <Copy size={11} />}
                {linkCopied ? 'copied' : 'share'}
              </button>
            </div>
            <Link
              href={creatorAddress ? `/profile/${creatorAddress}` : '#'}
              className="flex items-center gap-2 group w-fit"
            >
              {creatorAddress && (
                <ProfileAvatar address={creatorAddress} avatarUrl={creatorAvatar} size={22} />
              )}
              <span className="text-xs font-mono text-[#555] group-hover:text-[#888] transition-colors">
                {creatorName || shortAddress(creatorAddress)}
              </span>
            </Link>
            {meta.description && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">description</p>
                <p
                  ref={descRef}
                  className={`text-xs font-mono text-[#888] leading-relaxed ${showFullDesc ? '' : 'line-clamp-4'}`}
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
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="leave a comment… (optional)"
              rows={2}
              disabled={collecting}
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none disabled:opacity-50"
            />
          </div>

          {/* Spacer — pushes bottom group down when content is short */}
          <div className="flex-1 min-h-6" />

          {/* Distribute earnings (floats above collect) */}
          {isCreator && hasSplits && (
            <div className="px-5 pb-4 flex flex-col gap-2">
              <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">distribute earnings</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={splitAddress}
                  onChange={(e) => setSplitAddress(e.target.value)}
                  placeholder="0x… split address"
                  className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
                />
                <button
                  onClick={handleDistribute}
                  disabled={distributing || !splitAddress.trim()}
                  className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
                >
                  {distributing ? '…' : '→'}
                </button>
              </div>
              {distributeHash && (
                <a
                  href={`https://basescan.org/tx/${distributeHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-[#555] hover:text-[#888]"
                >
                  distributed: {distributeHash.slice(0, 10)}…{distributeHash.slice(-8)}
                </a>
              )}
            </div>
          )}

          {/* List + Collect — hugs the bottom */}
          <div className="px-5 py-4 flex gap-2 items-stretch">
            {alreadyOwned && (
              <div className="w-2/5 flex-none">
                <ListButton
                  collectionAddress={address}
                  tokenId={tokenId}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                  narrowInput
                />
              </div>
            )}
            <div className={`flex ${alreadyOwned ? 'flex-1' : 'w-full'} border transition-colors ${
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
                  {detail == null ? '…' : (detail.maxSupply == null || detail.maxSupply === 0 ? '∞' : detail.maxSupply.toLocaleString())}
                </span>
              </div>
              <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
            </div>
          </div>

          {/* Site admin — feature/unfeature */}
          {isAdmin && (
            <div className="px-5 pb-4">
              <button
                onClick={() => toggleFeatured(address, tokenId)}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors w-fit ${
                  isFeatured ? 'text-yellow-400' : 'text-[#555] hover:text-[#888]'
                }`}
              >
                <Star size={12} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
                {isFeatured ? 'unfeature' : 'feature'}
              </button>
            </div>
          )}

        </div>
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[200] bg-black/95 flex items-center justify-center"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 z-10 p-2 text-[#888] hover:text-[#efefef] transition-colors"
          >
            <X size={18} />
          </button>
          {isVideo && mediaUrl ? (
            <video
              src={mediaUrl}
              className="max-h-[95vh] max-w-[95vw] object-contain"
              autoPlay muted loop playsInline
              onClick={(e) => e.stopPropagation()}
            />
          ) : imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt={meta.name ?? 'moment'}
              className="max-h-[95vh] max-w-[95vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
