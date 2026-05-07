'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Star, Copy, Check, ExternalLink, EyeOff } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import {
  resolveUri,
  formatPrice,
  shortAddress,
  inferCollectCurrency,
  DEFAULT_COLLECT_COMMENT,
  type Moment,
  type MomentDetail,
} from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useTextContent, fetchTextContent } from '@/lib/textCache'
import { getCachedComments, setCachedComments } from '@/lib/momentCache'
import { useAdmin } from '@/contexts/AdminContext'
import { ERC1155_ABI } from '@/lib/seaport'
import { useDirectCollect, type CollectCurrency } from '@/hooks/useDirectCollect'
import { ListButton } from './ListButton'
import { MomentModal } from './MomentModal'
import { ProfileAvatar } from './ProfileAvatar'

interface MomentCardProps {
  moment: Moment
  hidePriceSupply?: boolean
  directLink?: boolean
}

export function MomentCard({ moment, hidePriceSupply, directLink }: MomentCardProps) {
  const router = useRouter()
  const [imgError, setImgError] = useState(false)
  const [price, setPrice] = useState<string | null>(null)
  const [pricePerToken, setPricePerToken] = useState<bigint | null>(null)
  const [currency, setCurrency] = useState<CollectCurrency | null>(null)
  const [maxSupply, setMaxSupply] = useState<number | null | undefined>(undefined)
  // Seed with the inprocess-provided username when available so we never
  // flash a raw address for users who set their name on inprocess but not
  // on Kismet. Falls back to shortAddress until Kismet's profile cache
  // resolves below; if Kismet has a different (resolved) username it wins.
  const [creatorName, setCreatorName] = useState(
    () => moment.creator.username || shortAddress(moment.creator.address),
  )
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [modalOpen, setModalOpen] = useState(false)
  const [collected, setCollected] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'

  useEffect(() => {
    fetchCreatorProfile(moment.creator.address).then(({ name, avatarUrl }) => {
      // Only overwrite when Kismet returned an actual resolved name —
      // otherwise the seeded inprocess username (or shortAddress fallback)
      // already in state is at least as good as Kismet's shortAddress.
      const resolved = !!name && name !== shortAddress(moment.creator.address)
      if (resolved) setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
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

  // Fetch sale config: needed for both display (price + supply) AND collect
  // (price + currency drive the on-chain mint call). hidePriceSupply only
  // controls whether we show the badges, not whether we fetch — otherwise
  // collect would be permanently disabled in compact contexts.
  useEffect(() => {
    const params = new URLSearchParams({
      collectionAddress: moment.address,
      tokenId: moment.token_id,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => r.ok ? r.json() as Promise<MomentDetail> : Promise.reject())
      .then((detail) => {
        const cur = inferCollectCurrency(detail.saleConfig)
        setPrice(formatPrice(detail.saleConfig.pricePerToken, cur))
        setPricePerToken(BigInt(detail.saleConfig.pricePerToken))
        setCurrency(cur)
        setMaxSupply(detail.maxSupply ?? null)
      })
      .catch(() => {})
  }, [moment.address, moment.token_id])

  function prefetchComments() {
    if (getCachedComments(moment.address, moment.token_id)) return
    const params = new URLSearchParams({ collectionAddress: moment.address, tokenId: moment.token_id, chainId: '8453' })
    fetch(`/api/moment/comments?${params}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCachedComments(moment.address, moment.token_id, data.comments ?? []) })
      .catch(() => {})
  }

  function prefetchTextContent() {
    const uri = meta.content?.uri
    if (isTextMoment && uri) fetchTextContent(uri).catch(() => {})
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${moment.address}/${moment.token_id}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  async function handleCollect() {
    if (!isConnected || !connectedAddress) { openConnectModal?.(); return }
    if (pricePerToken === null || currency === null) return // sale config not yet loaded
    const result = await collect({
      collectionAddress: moment.address as `0x${string}`,
      tokenId: moment.token_id,
      pricePerToken,
      currency,
      amount: 1,
      comment: DEFAULT_COLLECT_COMMENT,
    })
    if (result) setCollected(true)
  }
  const collectReady = pricePerToken !== null && currency !== null

  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const isTextMoment = meta.content?.mime === 'text/plain'
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)
  return (
    <>
      <article className="group flex flex-col bg-[#161616] border border-[#2a2a2a] overflow-hidden">
        {/* Media — click opens modal on desktop, navigates to detail page on mobile */}
        <div
          onClick={() => {
            if (directLink || window.innerWidth < 640) {
              router.push(`/moment/${moment.address}/${moment.token_id}`)
            } else {
              setModalOpen(true)
            }
          }}
          onMouseEnter={() => { prefetchComments(); prefetchTextContent() }}
          className="cursor-pointer relative aspect-square bg-[#111] overflow-hidden"
        >
          {isAdmin && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                toggleFeatured(moment.address, moment.token_id)
              }}
              className={`absolute top-2 left-2 z-10 p-1 transition-colors ${
                isFeatured ? 'text-yellow-400' : 'text-[#333] hover:text-[#888]'
              }`}
              title={isFeatured ? 'Unfeature' : 'Feature'}
            >
              <Star size={16} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
            </button>
          )}
          {moment.hidden ? (
            <span className="absolute top-2 right-2 z-10 p-1 bg-[#0d0d0d]/80 border border-[#2a2a2a]">
              <EyeOff size={10} className="text-[#555]" />
            </span>
          ) : (owned > 0 && maxSupply !== null) ? (
            <span className="absolute top-2 right-2 z-10 px-1.5 py-0.5 bg-[#0d0d0d]/80 border border-[#2a2a2a] text-[#efefef] font-mono text-[10px] leading-tight">
              ×{owned}
            </span>
          ) : null}
          {isVideo && mediaUrl ? (
            <video
              src={mediaUrl}
              className="w-full h-full object-contain"
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
              className="object-contain transition-transform duration-500 group-hover:scale-105"
              onError={() => setImgError(true)}
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            />
          ) : isTextMoment ? (
            <div className="w-full h-full flex flex-col p-5 bg-gradient-to-br from-[#1a1a1a] to-[#0a0a0a]">
              <span className="text-[10px] font-mono text-[#555] uppercase tracking-widest mb-2">writing</span>
              <p className="text-xs sm:text-sm font-mono text-[#bbb] line-clamp-7 leading-relaxed whitespace-pre-wrap">
                {textSnippet ?? meta.name ?? 'untitled'}
              </p>
            </div>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
            </div>
          )}
        </div>

        {/* Info */}
        <div className="px-4 pt-4 pb-3 flex flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <h3 className="text-sm text-[#efefef] font-mono truncate flex-1 min-w-0">
              {meta.name ?? `#${moment.token_id}`}
            </h3>
            {/* Share + external link */}
            <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
              <button
                onClick={handleCopyLink}
                title="copy link"
                className="text-[#444] hover:text-[#888] transition-colors"
              >
                {linkCopied
                  ? <Check size={11} className="text-[#6ee7b7]" />
                  : <Copy size={11} />}
              </button>
              {!directLink && (
                <Link
                  href={`/moment/${moment.address}/${moment.token_id}`}
                  title="view page"
                  className="text-[#444] hover:text-[#888] transition-colors"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink size={11} />
                </Link>
              )}
            </div>
          </div>
          <Link
            href={`/profile/${moment.creator.address}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 group/creator w-fit"
            title={moment.creator.address}
          >
            <ProfileAvatar address={moment.creator.address} avatarUrl={creatorAvatar} size={16} />
            <span className="text-xs text-[#555] font-mono group-hover/creator:text-[#888] transition-colors">{creatorName}</span>
          </Link>
        </div>

        {/* Actions row: [price|supply] [list] [collect] */}
        <div className="px-4 pb-4 flex gap-2 items-stretch">
          {!hidePriceSupply && owned === 0 && !collected && (
            <div className="flex border border-[#2a2a2a] flex-none">
              <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
              {maxSupply !== null && maxSupply !== undefined && maxSupply > 0 && (
                <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                  <span className="text-[11px] font-mono text-[#444]">{maxSupply.toLocaleString()}</span>
                </div>
              )}
            </div>
          )}
          {owned > 0 && (
            <div className="flex-1 min-w-0">
              <ListButton
                collectionAddress={moment.address}
                tokenId={moment.token_id}
                name={meta.name}
                image={meta.image ? resolveUri(meta.image) : undefined}
                creatorAddress={moment.creator?.address}
                contentUri={meta.content?.uri}
                contentMime={meta.content?.mime}
                buttonClassName={hidePriceSupply ? 'py-3' : 'py-2'}
              />
            </div>
          )}
          <button
            onClick={handleCollect}
            disabled={collecting || collected || owned > 0 || !collectReady}
            className={`flex-1 ${hidePriceSupply ? 'py-2' : 'py-2.5'} text-xs font-mono tracking-wider uppercase border transition-all disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
              collected || owned > 0
                ? 'text-[#8B5CF6] bg-[#8B5CF6]/10 border-[#8B5CF6]'
                : 'text-[#555] border-[#2a2a2a] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white hover:border-[#8B5CF6]'
            }`}
          >
            {collecting ? 'collecting…' : (collected || owned > 0) ? 'collected' : 'collect'}
          </button>
        </div>
      </article>

      {!directLink && modalOpen && (
        <MomentModal
          moment={moment}
          onClose={() => setModalOpen(false)}
          initialPrice={price ?? undefined}
          initialPricePerToken={pricePerToken ?? undefined}
          initialCurrency={currency ?? undefined}
          initialMaxSupply={maxSupply !== undefined ? maxSupply : undefined}
          initialCreatorName={creatorName}
          initialCreatorAvatar={creatorAvatar}
          initialOwnedBalance={ownedBalance !== undefined ? Number(ownedBalance) : undefined}
        />
      )}
    </>
  )
}
