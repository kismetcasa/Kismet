'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { X, Star, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import {
  resolveUri, formatPrice, shortAddress, formatRelativeTime, inferCollectCurrency, DEFAULT_COLLECT_COMMENT,
  type Moment, type MomentDetail, type MomentComment,
} from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect, type CollectCurrency } from '@/hooks/useDirectCollect'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useMomentSplits } from '@/hooks/useMomentSplits'
import { ListButton } from './ListButton'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { isVideoMoment } from '@/lib/media/isVideo'
import { ProfileAvatar } from './ProfileAvatar'
import { SplitsPanel } from './SplitsPanel'
import { useAdmin } from '@/contexts/AdminContext'

interface MomentModalProps {
  moment: Moment
  onClose: () => void
  // Props pre-populated by MomentCard to avoid redundant fetches
  initialPrice?: string
  initialPricePerToken?: bigint
  initialCurrency?: CollectCurrency
  initialCreatorName?: string
  initialCreatorAvatar?: string
  initialCollectionName?: string | null
  initialCollectionImage?: string | null
  initialOwnedBalance?: number
}

export function MomentModal({
  moment,
  onClose,
  initialPrice,
  initialPricePerToken,
  initialCurrency,
  initialCreatorName,
  initialCreatorAvatar,
  initialCollectionName,
  initialCollectionImage,
  initialOwnedBalance,
}: MomentModalProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [collected, setCollected] = useState(false)
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'
  const [creatorName, setCreatorName] = useState(
    () => initialCreatorName ?? shortAddress(moment.creator.address),
  )
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(initialCreatorAvatar)
  const [collectionName, setCollectionName] = useState<string | null>(
    initialCollectionName ?? null,
  )
  const [collectionImage, setCollectionImage] = useState<string | null>(
    initialCollectionImage ?? null,
  )
  const [collectionImageFailed, setCollectionImageFailed] = useState(false)
  const [comments, setComments] = useState<MomentComment[]>(
    () => getCachedComments(moment.address, moment.token_id) ?? []
  )
  const [commentsLoading, setCommentsLoading] = useState(
    () => getCachedComments(moment.address, moment.token_id) === undefined
  )
  const [linkCopied, setLinkCopied] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const [imgError, setImgError] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()

  const meta = moment.metadata ?? {}
  const isVideo = isVideoMoment(meta)
  const isTextMoment = meta.content?.mime === 'text/plain'
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)
  const creatorAddress = moment.creator.address
  const isFeatured = featuredKeys.has(`${moment.address.toLowerCase()}:${moment.token_id}`)

  // Only query on-chain balance when card didn't pass it in
  const { data: ownedBalance, refetch: refetchOwnedBalance } = useReadContract({
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

  // Polled so "X collected" updates after a fresh collect without waiting
  // for the inprocess indexer.
  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(moment.token_id)],
    query: { refetchInterval: 30_000 },
  })
  const maxSupply = tokenInfo?.maxSupply
  const totalMinted = tokenInfo?.totalMinted

  // Creator-only distribute UI. Use the prop's creator (always present) so
  // the check can render before MomentDetail loads.
  const isCreator =
    !!connectedAddress &&
    connectedAddress.toLowerCase() === creatorAddress.toLowerCase()

  const { hasSplits, recipients: splitRecipients, splitAddress, distribute, distributing, distributeHash } = useMomentSplits({
    address: moment.address,
    tokenId: moment.token_id,
    isCreator,
  })

  const pricePerToken = initialPricePerToken ?? (detail ? BigInt(detail.saleConfig.pricePerToken) : null)
  const currency = initialCurrency ?? (detail ? inferCollectCurrency(detail.saleConfig) : null)
  const price = initialPrice ?? (detail && currency ? formatPrice(detail.saleConfig.pricePerToken, currency) : null)
  const collectReady = pricePerToken !== null && currency !== null

  useEffect(() => {
    if (initialPrice !== undefined) return
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
  }, [moment.address, moment.token_id, initialPrice])

  async function handleDistribute() {
    if (!currency) { toast.error('Sale config still loading'); return }
    await distribute(currency)
  }

  // Fetch creator profile via shared cache (cache hit if card already resolved it)
  useEffect(() => {
    fetchCreatorProfile(creatorAddress).then(({ name, avatarUrl }) => {
      setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [creatorAddress])

  // Cache-backed — hits when MomentCard already resolved it, fires a fetch
  // only when the modal is opened before the card's resolve landed.
  useEffect(() => {
    fetchCollectionChip(moment.address).then(({ name, image }) => {
      setCollectionName(name)
      setCollectionImage(image)
    })
  }, [moment.address])

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

  useBodyScrollLock()
  useEscapeKey(onClose)

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${moment.address}/${moment.token_id}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  async function handleCollect() {
    if (!isConnected || !connectedAddress) { openConnectModal?.(); return }
    if (pricePerToken === null || currency === null) return
    const result = await collect({
      collectionAddress: moment.address as `0x${string}`,
      tokenId: moment.token_id,
      pricePerToken,
      currency,
      amount: 1,
      comment: DEFAULT_COLLECT_COMMENT,
    })
    if (result) {
      setCollected(true)
      refetchTokenInfo().catch(() => {})
      refetchOwnedBalance().catch(() => {})
    }
  }

  const hasCollected = alreadyOwned || collected
  // Wait for both reads before flagging — otherwise we'd flash "minted out"
  // before tokenInfo lands.
  const mintedOut =
    maxSupply !== undefined &&
    totalMinted !== undefined &&
    !isOpenEdition(maxSupply) &&
    totalMinted >= maxSupply
  const collectLabel = collecting
    ? 'collecting…'
    : mintedOut
      ? hasCollected ? 'collected' : 'minted out'
      : hasCollected ? 'collect more' : 'collect'

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

        {/* Left: media — click navigates to detail page. Aspect 4:5 with
            object-contain so non-square art letterboxes cleanly instead of
            cropping (matches the in_process pattern for moment media). */}
        <div className="relative aspect-[4/5] bg-[#111] flex-shrink-0 border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a]">
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
          {/* Navigate to detail page on click. Don't close the modal here —
              closing first reveals the homepage for the duration of the
              client navigation, producing a visible flash. Letting the
              modal stay mounted means the user keeps seeing the moment
              while the next route loads. */}
          <Link
            href={`/moment/${moment.address}/${moment.token_id}`}
            className="absolute inset-0 z-10 cursor-pointer"
          />
          {isVideo && meta.animation_url ? (
            <MomentVideo
              src={meta.animation_url}
              poster={meta.image}
              thumbhash={meta.kismet_thumbhash}
              showPosterLayer
              preload="auto"
              className="w-full h-full object-contain"
            />
          ) : meta.image && !imgError ? (
            <MomentImage
              src={meta.image}
              alt={meta.name ?? 'moment'}
              fill
              className="object-contain"
              onAllError={() => setImgError(true)}
              sizes="(max-width: 768px) 100vw, 50vw"
              mime={meta.content?.mime}
              thumbhash={meta.kismet_thumbhash}
              // Modal opens on click — user is actively waiting for this image,
              // so it's effectively above-the-fold even though it wasn't on
              // initial paint.
              priority
            />
          ) : isTextMoment ? (
            <div className="w-full h-full flex flex-col p-6 sm:p-8 bg-gradient-to-br from-[#1a1a1a] to-[#0a0a0a]">
              <span className="text-[10px] font-mono text-[#555] uppercase tracking-widest mb-3">writing</span>
              {meta.name && (
                <p className="text-base font-mono text-[#efefef] truncate mb-3">
                  {meta.name}
                </p>
              )}
              {textSnippet && (
                <p className="text-sm font-mono text-[#bbb] leading-relaxed whitespace-pre-wrap">
                  {textSnippet}
                </p>
              )}
              {!meta.name && !textSnippet && (
                <p className="text-sm font-mono text-[#bbb]">untitled</p>
              )}
            </div>
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

            {collectionName && (
              <Link
                href={`/collection/${moment.address}`}
                onClick={onClose}
                className="flex items-center gap-2 group w-fit"
              >
                {collectionImage && !collectionImageFailed && (
                  <div className="w-5 h-5 relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
                    <MomentImage
                      src={collectionImage}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="20px"
                      onAllError={() => setCollectionImageFailed(true)}
                    />
                  </div>
                )}
                <span className="text-xs font-mono text-[#555] group-hover:text-[#888] transition-colors">
                  {collectionName}
                </span>
              </Link>
            )}

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

            {hasSplits && <SplitsPanel recipients={splitRecipients} onNavigate={onClose} />}

            {/* Comments */}
            {!commentsLoading && comments.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">comments</p>
                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
                  {comments.map((c, i) => (
                    <div key={i} className="flex gap-2 items-baseline">
                      <Link
                        href={`/profile/${c.sender}`}
                        onClick={onClose}
                        className="text-[11px] font-mono text-[#555] flex-shrink-0 hover:text-[#888] transition-colors"
                      >
                        {shortAddress(c.sender)}
                      </Link>
                      <span className="text-xs font-mono text-[#888] flex-1 break-words leading-relaxed">
                        {c.comment}
                      </span>
                      <span className="text-[10px] font-mono text-[#333] flex-shrink-0">
                        {formatRelativeTime(c.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1 min-h-4" />

          {/* Distribute earnings (creator + has-splits) — sits above collect */}
          {isCreator && hasSplits && (
            <div className="px-5 pb-2 flex flex-col gap-2">
              <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">distribute earnings</p>
              <button
                onClick={handleDistribute}
                disabled={distributing || !splitAddress}
                className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
              >
                {distributing ? 'distributing…' : splitAddress ? 'distribute' : 'loading…'}
              </button>
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

          {/* Total collected stat — directly above the action row */}
          {totalMinted !== undefined && (
            <div className="px-5 -mb-1">
              <p className="text-[10px] font-mono text-[#555] uppercase tracking-widest">
                {Number(totalMinted).toLocaleString()} collected
              </p>
            </div>
          )}

          {/* Action row: [price|supply] [list] [collect] */}
          <div className="px-5 pb-2 flex gap-2 items-stretch">
            {!(alreadyOwned || collected) && (
              <div className="flex border border-[#2a2a2a] flex-none">
                <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                  <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
                </div>
                <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                  <span className="text-[11px] font-mono text-[#444]">
                    {maxSupply === undefined
                      ? '…'
                      : isOpenEdition(maxSupply)
                        ? 'open'
                        : maxSupply.toLocaleString()}
                  </span>
                </div>
              </div>
            )}
            {alreadyOwned && (
              <div className="flex-1 min-w-0">
                <ListButton
                  collectionAddress={moment.address}
                  tokenId={moment.token_id}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                  contentUri={meta.content?.uri}
                  contentMime={meta.content?.mime}
                  buttonClassName="h-full"
                />
              </div>
            )}
            <button
              onClick={handleCollect}
              disabled={collecting || mintedOut || !collectReady}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase border transition-all disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
                hasCollected
                  ? 'text-[#8B5CF6] bg-[#8B5CF6]/10 border-[#8B5CF6] hover:bg-[#8B5CF6]/20'
                  : 'text-[#555] border-[#2a2a2a] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white hover:border-[#8B5CF6]'
              }`}
            >
              {collectLabel}
            </button>
          </div>

          {/* View page — hugs bottom. Same no-onClose treatment as the
              media link above, for the same reason. */}
          <div className="px-5 pb-5">
            <Link
              href={`/moment/${moment.address}/${moment.token_id}`}
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
