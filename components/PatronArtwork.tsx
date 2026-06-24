'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import {
  formatPrice,
  shortAddress,
  inferCollectCurrency,
  DEFAULT_COLLECT_COMMENT,
  type Moment,
} from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { useTextContent } from '@/lib/textCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useMomentSale } from '@/hooks/useMomentSale'
import { useDirectCollect, type CollectCurrency } from '@/hooks/useDirectCollect'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { RaffleButton } from './RaffleButton'
import { RaffleAdminPanel } from './RaffleAdminPanel'

// Soft-gold showcase box — the same signifier the Mint Pass Display
// (FeaturedMoment) uses, so the Patron page reads as the same "this is the
// hero artwork" treatment. Dark text clears ~9.4:1 on it.
const DISPLAY_BG = '#d4b062'
// Max artwork height; the box hugs the artwork's aspect ratio up to this, so
// portrait pieces get gold matting on the sides and landscape pieces fill the
// width without ever letterboxing.
const ART_MAX_H = 520
const DEFAULT_RATIO = 1.5
const MIN_RATIO = 0.2
const MAX_RATIO = 5
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))

interface PatronArtworkProps {
  moment: Moment
  /** Editorial copy beneath the display; falls back to on-chain description. */
  description?: string
  /** Above-the-fold hint for the first artwork (it leads the page, LCP). */
  priority?: boolean
}

/**
 * One Patron Collection artwork rendered as a big horizontal display (the
 * artwork on a soft-gold band, hugging its own aspect ratio) with its title,
 * artist, a description, and a collect action beneath. Self-contained: it
 * resolves price (useMomentSale) and supply (getTokenInfo) for the collect
 * button the same way MomentCard does, so collecting here unlocks mint access
 * without leaving the page.
 *
 * Owners get an "enter raffle" affordance; admins get the raffle picker panel.
 */
export function PatronArtwork({ moment, description, priority }: PatronArtworkProps) {
  const { address, token_id: tokenId } = moment
  const meta = moment.metadata ?? {}
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting =
    collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'

  const [collected, setCollected] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)
  const [artist, setArtist] = useState<string>(
    moment.creator.username || shortAddress(moment.creator.address),
  )

  // Resolve a nicer artist label from the profile cache, same as the feed.
  useEffect(() => {
    const addr = moment.creator.address
    if (!addr) return
    fetchCreatorProfile(addr)
      .then(({ name }) => {
        const isUsername = !!name && name !== shortAddress(addr)
        if (isUsername) setArtist(name)
      })
      .catch(() => {})
  }, [moment.creator.address])

  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(
    () => thumbhashToBlurDataURL(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const thumbRatio = useMemo(
    () => thumbhashToRatio(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)

  // Exact natural ratio wins once the image loads; the thumbhash ratio is the
  // shift-free initial guess; a landscape guess covers the pre-data window.
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  // ── Price + supply for the collect button (same path as MomentCard) ──
  const { data: saleData } = useMomentSale(address, tokenId, !moment.saleConfig)
  const { price, pricePerToken, currency } = useMemo<{
    price: string | null
    pricePerToken: bigint | null
    currency: CollectCurrency | null
  }>(() => {
    const sc = moment.saleConfig ?? saleData ?? null
    if (!sc) return { price: null, pricePerToken: null, currency: null }
    try {
      const cur = inferCollectCurrency(sc)
      return { price: formatPrice(sc.pricePerToken, cur), pricePerToken: BigInt(sc.pricePerToken), currency: cur }
    } catch {
      return { price: null, pricePerToken: null, currency: null }
    }
  }, [moment.saleConfig, saleData])

  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContract({
    address: address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(tokenId)],
  })
  const maxSupply = tokenInfo?.maxSupply
  const totalMinted = tokenInfo?.totalMinted

  const { data: ownedBalance, refetch: refetchOwnedBalance } = useReadContract({
    address: address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(tokenId)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const owned = ownedBalance ? Number(ownedBalance) : 0
  const hasCollected = collected || owned > 0
  const mintedOut =
    maxSupply !== undefined &&
    totalMinted !== undefined &&
    !isOpenEdition(maxSupply) &&
    totalMinted >= maxSupply
  const collectReady = pricePerToken !== null && currency !== null

  async function handleCollect() {
    if (!isConnected || !connectedAddress) {
      openConnectModal?.()
      return
    }
    // collect() resolves the live on-chain sale (price/currency/window) itself
    // now; we still gate on a known sale for the button's enabled state.
    if (pricePerToken === null || currency === null) return
    const result = await collect({
      collectionAddress: address as `0x${string}`,
      tokenId,
      amount: 1,
      comment: DEFAULT_COLLECT_COMMENT,
    })
    if (result) {
      setCollected(true)
      refetchOwnedBalance().catch(() => {})
      refetchTokenInfo().catch(() => {})
    }
  }

  const collectLabel = collecting
    ? 'collecting…'
    : mintedOut
      ? hasCollected ? 'collected' : 'minted out'
      : hasCollected ? 'collect another' : 'collect'

  const title = meta.name ?? `#${tokenId}`
  const momentHref = `/moment/${address}/${tokenId}`
  const profileHref = moment.creator.address ? `/profile/${moment.creator.address}` : undefined
  const body = description ?? meta.description

  return (
    <article className="flex flex-col gap-5">
      {/* Big horizontal display — artwork centered on the soft-gold band,
          sized to hug its aspect ratio (no crop, no letterbox). */}
      <Link
        href={momentHref}
        className="relative w-full flex items-center justify-center border border-line overflow-hidden"
        style={{ backgroundColor: DISPLAY_BG }}
      >
        <div
          className="relative"
          style={{ width: `min(100%, calc(${ART_MAX_H}px * ${aspectRatio}))`, aspectRatio }}
        >
          {isVideo && media.src && !mediaError ? (
            <MomentVideo
              src={media.src}
              poster={media.poster}
              thumbhash={meta.kismet_thumbhash}
              showPosterLayer
              className="w-full h-full object-contain"
              priority={priority}
              onAllError={() => setMediaError(true)}
            />
          ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !mediaError ? (
            <MomentImage
              src={media.src}
              alt={title}
              fill
              className="object-contain"
              sizes="(max-width: 1024px) 100vw, 1024px"
              mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
              thumbhash={meta.kismet_thumbhash}
              priority={priority}
              onNaturalSize={handleNaturalSize}
              onAllError={() => setMediaError(true)}
            />
          ) : isTextMoment ? (
            <div className="w-full h-full flex flex-col p-8 overflow-hidden">
              <span className="text-[10px] font-mono text-black/60 uppercase tracking-widest mb-3">writing</span>
              {meta.name && <p className="text-xl font-mono text-[#0d0d0d] mb-3 truncate">{meta.name}</p>}
              {textSnippet && (
                <p className="text-sm font-mono text-black/80 leading-relaxed whitespace-pre-wrap">{textSnippet}</p>
              )}
            </div>
          ) : blurPreview ? (
            <span aria-hidden className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${blurPreview})` }} />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-black/50 font-mono text-xs">no preview</span>
            </div>
          )}
        </div>
      </Link>

      {/* Title · artist · description · collect */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-mono text-ink">{title}</h2>
          {artist && (
            <p className="text-xs font-mono text-muted">
              by{' '}
              {profileHref ? (
                <Link href={profileHref} className="text-dim hover:text-ink transition-colors">
                  {artist.startsWith('@') ? artist : `@${artist}`}
                </Link>
              ) : (
                <span className="text-dim">{artist}</span>
              )}
            </p>
          )}
        </div>

        {body && (
          <p className="text-sm font-mono text-dim leading-relaxed whitespace-pre-wrap max-w-2xl">
            {body}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleCollect}
            disabled={collecting || mintedOut || !collectReady}
            className={`min-w-[10rem] px-6 py-2.5 text-xs font-mono tracking-widest uppercase border transition-colors disabled:opacity-50 ${
              collecting ? 'cursor-not-allowed' : ''
            } ${
              hasCollected
                ? 'text-accent bg-accent/10 border-accent hover:bg-accent/20'
                : 'text-muted border-line accent-grad-hover'
            }`}
          >
            {collectLabel}
          </button>
          {!hasCollected && price && (
            <span className="text-xs font-mono text-dim">
              <span className="accent-grad">{price}</span> per edition
            </span>
          )}
          {hasCollected && (
            <span className="inline-flex items-center gap-1.5 text-xs font-mono text-accent">
              <Check size={13} strokeWidth={2.5} />
              mint access unlocked
            </span>
          )}
        </div>

        {/* Owners can enter the raffle right here (also available on the
            owned-edition card / detail view via CollectedActions). */}
        {owned > 0 && (
          <div className="max-w-[14rem]">
            <RaffleButton collectionAddress={address} tokenId={tokenId} />
          </div>
        )}

        {/* Admin-only raffle controls (self-hides for non-admins). */}
        <RaffleAdminPanel collection={address} tokenId={tokenId} />
      </div>
    </article>
  )
}
