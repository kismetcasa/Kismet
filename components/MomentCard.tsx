'use client'

import { memo, useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Star, Copy, Check, EyeOff, ArrowUpRight } from 'lucide-react'
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
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent, fetchTextContent } from '@/lib/textCache'
import { getCachedComments, setCachedComments } from '@/lib/momentCache'
import { useAdmin } from '@/contexts/AdminContext'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect, type CollectCurrency } from '@/hooks/useDirectCollect'
import { ListButton } from './ListButton'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { setVideoDuration } from '@/lib/media/durationCache'
import { ProfileAvatar } from './ProfileAvatar'

interface MomentCardProps {
  moment: Moment
  hidePriceSupply?: boolean
  /**
   * Above-the-fold hint. Forwards next/image priority + fetchpriority=high
   * so the first row of a feed isn't lazy-loaded behind hydration.
   */
  priority?: boolean
  /**
   * Compact mode for tight grids — the featured-collection-row's 10×2
   * mints preview (~130px wide) and the discover/trending/market grid
   * view (~150-200px wide at lg+). Drops the collection chip and
   * copy-link button; action row stacks price·supply inline above the
   * collect button so the 56px min-width chip doesn't overflow.
   */
  compact?: boolean
  /**
   * Force the creator chip on/off independent of `compact`. The grid
   * view passes true (cards are wide enough to fit the chip); the
   * featured-collection-row leaves it unset so its compact cards stay
   * chip-free (the row's parent surface already shows the creator).
   */
  showCreator?: boolean
  /**
   * Opt-in: swap aspect-square for flex-1 on the image and h-full on
   * the article so the card stretches to fill a parent grid/flex cell.
   * Ignored when !compact.
   */
  fillCell?: boolean
  /**
   * When provided AND moment.address matches passCollection AND the
   * referenced holder has validBalance ≥ 1, render an accent-color
   * "valid Pass" check badge bottom-right of the image. Used by
   * ProfileView's collected list so a holder sees their Pass marked as
   * granting mint access — and so support requests like "why can't I
   * mint" become self-diagnosable from a glance at the profile.
   */
  passBadge?: { passCollection: string; hasValidity: boolean }
  /**
   * Discovery-context flag (the artists tab): the card's primary action
   * steers to the creator's profile. In the non-owned full layout the row
   * is [view profile][collect]; compact shows a single "view profile"; an
   * owner's full card keeps "collect+" on the right and swaps the left
   * "list" for "view profile".
   */
  profileCta?: boolean
}

// Memoized — feeds render 18+ cards each doing 3-5 async lookups, so a
// parent re-render would otherwise re-run them all. Default shallow
// compare works: `moment` is stable across renders (held in parent
// useState arrays); other props are primitives.
function MomentCardImpl({ moment, hidePriceSupply, priority, compact, showCreator, fillCell, passBadge, profileCta }: MomentCardProps) {
  // Default: creator chip follows compact mode (visible non-compact,
  // hidden compact). `showCreator` overrides either direction.
  const renderCreator = showCreator ?? !compact
  const router = useRouter()
  // Dedups onMouseEnter prefetches per card identity — without this every
  // re-entry refires comments + text + route prefetches.
  const prefetchedRef = useRef<string>('')
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const [price, setPrice] = useState<string | null>(null)
  const [pricePerToken, setPricePerToken] = useState<bigint | null>(null)
  const [currency, setCurrency] = useState<CollectCurrency | null>(null)
  // Seed with the inprocess-provided username when available so we never
  // flash a raw address for users who set their name on inprocess but not
  // on Kismet. Falls back to shortAddress until Kismet's profile cache
  // resolves below; if Kismet has a different (resolved) username it wins.
  const [creatorName, setCreatorName] = useState(
    () => moment.creator.username || shortAddress(moment.creator.address),
  )
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(
    () => moment.creator.avatarUrl,
  )
  // Stays null for non-platform addresses (auto-deploy wrappers, unknown
  // contracts) — keeps the chip hidden for individual mints.
  const [collectionName, setCollectionName] = useState<string | null>(
    () => moment.kismetCollection?.name ?? null,
  )
  const [collectionImage, setCollectionImage] = useState<string | null>(
    () => moment.kismetCollection?.image ?? null,
  )
  const [collectionImageFailed, setCollectionImageFailed] = useState(false)
  const [collected, setCollected] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const { address: connectedAddress, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'

  useEffect(() => {
    // Skip when the server stitched both fields. FC-only creators
    // (no Kismet KV) fall through so fetchCreatorProfile can resolve
    // their FC pfp client-side.
    if (moment.creator.username && moment.creator.avatarUrl) return
    fetchCreatorProfile(moment.creator.address).then(({ name, avatarUrl }) => {
      // Only overwrite when Kismet returned an actual resolved name —
      // otherwise the seeded inprocess username (or shortAddress fallback)
      // already in state is at least as good as Kismet's shortAddress.
      const resolved = !!name && name !== shortAddress(moment.creator.address)
      if (resolved) setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [moment.creator.address, moment.creator.username, moment.creator.avatarUrl])

  useEffect(() => {
    // `kismetCollection` defined (even with null name/image) signals
    // the server attempted enrichment — no need to re-confirm null.
    if (moment.kismetCollection !== undefined) return
    fetchCollectionChip(moment.address).then(({ name, image }) => {
      setCollectionName(name)
      setCollectionImage(image)
    })
  }, [moment.address, moment.kismetCollection])

  // Defer the per-card price fetch + the two on-chain reads off the initial
  // mount/scroll path. Firing them on mount stacks a network + RPC + re-render
  // burst onto the exact window where the feed is rendering in and the
  // shared-video reposition rAF is already contended — which is what makes the
  // overlay lag/mis-position while moments are still rendering. Waiting for
  // idle keeps that window light; price/supply still popcorn in a beat later,
  // and the collect button stays gated on collectReady until they land.
  const [deferReady, setDeferReady] = useState(false)
  useEffect(() => {
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(() => setDeferReady(true), { timeout: 1500 })
      return () => w.cancelIdleCallback?.(h)
    }
    const t = setTimeout(() => setDeferReady(true), 300)
    return () => clearTimeout(t)
  }, [])

  const { data: ownedBalance, refetch: refetchOwnedBalance } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    query: { enabled: deferReady && !!connectedAddress },
  })
  const owned = ownedBalance ? Number(ownedBalance) : 0

  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(moment.token_id)],
    query: { enabled: deferReady },
  })
  const maxSupply = tokenInfo?.maxSupply
  const totalMinted = tokenInfo?.totalMinted

  const meta = moment.metadata ?? {}
  const isFeatured = featuredKeys.has(`${moment.address.toLowerCase()}:${moment.token_id}`)

  // Price + currency. hidePriceSupply only controls badge rendering —
  // compact contexts still need these state values to drive collect.
  //
  // Two paths:
  //   1. Fast path: if a caller supplies moment.saleConfig, populate state
  //      directly and skip the round-trip. NOTE: /api/timeline does NOT stitch
  //      saleConfig today (server-side enrichment was reverted — see the
  //      comment near the end of app/api/timeline/route.ts), so feed moments
  //      fall through to path 2. This branch stays for any caller that does
  //      supply it (and for a future warm-cache enrichment).
  //   2. Canonical path for feed moments: fetch /api/moment per card. Deferred
  //      to idle (see deferReady) so it doesn't fire during the render-in
  //      window; price/supply popcorn in a beat later.
  useEffect(() => {
    if (moment.saleConfig) {
      // Match the fetch path's implicit error swallowing (the .catch
      // below covers the same setters). Without this, a malformed
      // pricePerToken string in an enriched timeline response would
      // throw out of BigInt() and bubble as an unhandled effect error
      // instead of letting the card render with un-set price state.
      try {
        const cur = inferCollectCurrency(moment.saleConfig)
        setPrice(formatPrice(moment.saleConfig.pricePerToken, cur))
        setPricePerToken(BigInt(moment.saleConfig.pricePerToken))
        setCurrency(cur)
      } catch {}
      return
    }
    // Held until idle (see deferReady) so the fetch doesn't fire during the
    // render-in window. The saleConfig fast-path above still runs immediately
    // when present.
    if (!deferReady) return
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
      })
      .catch(() => {})
  }, [moment.address, moment.token_id, moment.saleConfig, deferReady])

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
    if (result) {
      setCollected(true)
      refetchOwnedBalance().catch(() => {})
      refetchTokenInfo().catch(() => {})
    }
  }
  const collectReady = pricePerToken !== null && currency !== null
  const hasCollected = collected || owned > 0
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
      : hasCollected ? 'collect+' : 'collect'

  // Artists/roster tab: steer the primary action to the creator's profile.
  // Gated on a resolvable creator address so a malformed moment falls back
  // to the normal collect/list buttons rather than linking to /profile/undefined.
  const showProfileCta = !!profileCta && !!moment.creator?.address
  const renderViewProfile = (variant: 'compact' | 'full') => (
    <Link
      href={`/profile/${moment.creator?.address}`}
      onClick={(e) => e.stopPropagation()}
      className={
        variant === 'compact'
          ? 'block text-center w-full py-1.5 text-[10px] font-mono tracking-wider uppercase border text-muted border-line accent-grad-hover'
          : `flex-1 flex items-center justify-center ${hidePriceSupply ? 'py-2' : 'py-2.5'} text-xs font-mono tracking-wider uppercase border text-muted border-line accent-grad-hover transition-all`
      }
    >
      view profile
    </Link>
  )

  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(
    () => thumbhashToBlurDataURL(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)
  // Seed the duration cache for SharedVideoProvider.createVideo to read
  // before this card's SharedVideoSlot effect fires. Idempotent (Map.set
  // with same value) so re-renders are free. Skipped for non-video and
  // for moments without the server-stitched kismet_duration_sec field
  // (older mints predating the durationSec write at /api/collections POST).
  if (isVideo && meta.animation_url && moment.kismet_duration_sec) {
    setVideoDuration(resolveUri(meta.animation_url), moment.kismet_duration_sec)
  }
  return (
    // content-visibility / contain-intrinsic-size were here originally
    // to skip render work for off-screen cards. Removed because on iOS
    // WebKit (the Mini App webview engine) the heuristic doesn't
    // un-skip reliably as cards scroll into view — users see long
    // blank gaps in the feed instead of card content. The render-time
    // savings on the desktop browsers that DO honour the property
    // aren't worth the visible breakage on the primary mobile path.
    <article
      className={`group flex flex-col bg-[#161616] border border-line overflow-hidden${fillCell && compact ? ' h-full' : ''}`}
    >
      {/* Media — wrapped in <Link> so the click triggers Next.js's
          intercepting route at app/@modal/(.)moment/.../page.tsx. The
          feed stays mounted; the detail page renders as an overlay
          above. Combined with SharedVideoProvider, the same <video>
          element CSS-transitions from card to overlay without re-mount.
          Direct URL load of /moment/X bypasses the interception and
          hits the canonical detail page. */}
      <Link
        href={`/moment/${moment.address}/${moment.token_id}`}
        onMouseEnter={() => {
          const key = `${moment.address}:${moment.token_id}`
          if (prefetchedRef.current === key) return
          prefetchedRef.current = key
          prefetchComments()
          prefetchTextContent()
          // Link auto-prefetches on hover (in production) but the
          // explicit prefetch warms the route bundle alongside the
          // comments/text caches.
          router.prefetch(`/moment/${moment.address}/${moment.token_id}`)
        }}
        className={`cursor-pointer relative bg-surface overflow-hidden block ${fillCell && compact ? 'flex-1 min-h-0' : 'aspect-square'}`}
      >
        {isAdmin && (
          <button
            onClick={(e) => {
              // Star sits inside the <Link>; preventDefault stops the
              // navigation that would otherwise fire, stopPropagation
              // belt-and-suspenders any future ancestor click handler.
              e.preventDefault()
              e.stopPropagation()
              toggleFeatured(moment.address, moment.token_id)
            }}
            className={`absolute top-1.5 left-1.5 z-10 min-w-10 min-h-10 flex items-center justify-center transition-colors ${
              isFeatured ? 'text-yellow-400' : 'text-faint hover:text-dim'
            }`}
            title={isFeatured ? 'Unfeature' : 'Feature'}
          >
            <Star size={16} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
          </button>
        )}
        {moment.hidden && (
          <span className="absolute top-2 right-2 z-10 p-1 bg-[#0d0d0d]/80 border border-line">
            <EyeOff size={10} className="text-muted" />
          </span>
        )}
        {/* Valid-Pass overlay. Shown on the holder's profile collected list
            so they can confirm at a glance that their Pass currently grants
            mint access. Hidden when this moment isn't in the gate's
            passCollection or when the holder's validBalance is 0 (e.g.
            transferred off-platform — they own the NFT but lost validity).
            Brand-accent colored, bottom-right of the image. */}
        {passBadge?.hasValidity
          && moment.address.toLowerCase() === passBadge.passCollection.toLowerCase() && (
          <span
            className="absolute bottom-2 right-2 z-10 w-7 h-7 rounded-full bg-accent flex items-center justify-center shadow-md"
            title="Valid Kismet Creator Pass — gates mint access"
          >
            <Check size={14} className="text-white" strokeWidth={2.5} />
          </span>
        )}
        {isVideo && media.src && !videoError ? (
          <MomentVideo
            src={media.src}
            poster={media.poster}
            thumbhash={meta.kismet_thumbhash}
            showPosterLayer
            className="w-full h-full object-contain"
            priority={priority}
            // A video that can't decode (e.g. a legacy non-iOS-safe mp4 on
            // WebKit) with no usable poster would otherwise paint a black
            // box. Fall through to the thumbhash blur / placeholder.
            onAllError={() => setVideoError(true)}
          />
        ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !imgError ? (
          <MomentImage
            src={media.src}
            alt={meta.name ?? 'moment'}
            fill
            className="object-contain transition-transform duration-500 group-hover:scale-105"
            onAllError={() => setImgError(true)}
            // Compact mode packs cards 2-6 across (profile grids and the
            // discover grid view). At ~16vw on desktop the feed-mode
            // default (33vw) would have the browser fetch 2x larger
            // images than rendered. Each branch is the actual width.
            sizes={compact
              ? '(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw'
              : '(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw'}
            // Force the gif mime so MomentImage skips the optimizer (which
            // flattens animation) and streams the animated bytes via /api/img.
            mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
            thumbhash={meta.kismet_thumbhash}
            priority={priority}
          />
        ) : isTextMoment ? (
          <div className="w-full h-full flex flex-col p-5 bg-gradient-to-br from-raised to-[#0a0a0a]">
            <span className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">writing</span>
            {meta.name && (
              <p className="text-sm sm:text-base font-mono text-ink truncate mb-2">
                {meta.name}
              </p>
            )}
            {textSnippet && (
              <p className="text-xs sm:text-sm font-mono text-[#bbb] leading-relaxed whitespace-pre-wrap">
                {textSnippet}
              </p>
            )}
            {!meta.name && !textSnippet && (
              <p className="text-xs sm:text-sm font-mono text-[#bbb]">untitled</p>
            )}
          </div>
        ) : blurPreview ? (
          // Media missing or every gateway errored, but we have a
          // thumbhash — paint the low-fi preview instead of a blank tile.
          <span
            aria-hidden
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url(${blurPreview})` }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-xs">no preview</span>
          </div>
        )}
      </Link>

      {/* Info */}
      <div className={`${compact ? 'px-2 pt-2 pb-1.5 gap-1' : 'px-4 pt-4 pb-3 gap-1.5'} flex flex-col`}>
        <div className="flex items-start gap-2">
          <h3 className={`${compact ? 'text-[11px]' : 'text-sm'} text-ink font-mono truncate flex-1 min-w-0`}>
            {meta.name ?? `#${moment.token_id}`}
          </h3>
          {!compact && (
            <div className="flex-shrink-0 mt-0.5 flex items-center gap-2">
              <button
                onClick={handleCopyLink}
                title="copy link"
                className="text-[#444] hover:text-dim transition-colors flex items-center"
              >
                {linkCopied
                  ? <Check size={11} className="text-[#6ee7b7]" />
                  : <Copy size={11} />}
              </button>
              {/* Hard-nav anchor so the click bypasses the @modal
                  intercepting route and lands on the canonical full-page
                  detail route — sibling to the copy affordance, same
                  visual weight. */}
              <a
                href={`/moment/${moment.address}/${moment.token_id}`}
                title="open full details page"
                className="text-[#444] hover:text-dim transition-colors flex items-center"
              >
                <ArrowUpRight size={11} />
              </a>
            </div>
          )}
        </div>
        {renderCreator && (
          <Link
            href={`/profile/${moment.creator.address}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 group/creator max-w-full"
            title={moment.creator.address}
          >
            <ProfileAvatar address={moment.creator.address} avatarUrl={creatorAvatar} size={compact ? 12 : 16} />
            {/* min-w-0 is what lets `truncate` actually clip — without it
                a flex child takes its natural width and overflows. Matters
                in grid view where cards are ~180px wide. */}
            <span className={`${compact ? 'text-[10px]' : 'text-xs'} text-muted font-mono group-hover/creator:text-dim transition-colors truncate min-w-0`}>
              {creatorName}
            </span>
          </Link>
        )}
        {!compact && collectionName && (
          <Link
            href={`/collection/${moment.address}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 group/collection w-fit"
            title={collectionName}
          >
            {collectionImage && !collectionImageFailed && (
              <div className="w-4 h-4 relative flex-shrink-0 bg-raised overflow-hidden">
                <MomentImage
                  src={collectionImage}
                  alt=""
                  fill
                  className="object-cover"
                  sizes="16px"
                  onAllError={() => setCollectionImageFailed(true)}
                />
              </div>
            )}
            <span className="text-xs text-muted font-mono group-hover/collection:text-dim transition-colors">
              {collectionName}
            </span>
          </Link>
        )}
      </div>

      {/* Actions row. Default: [price|supply] [list] [collect] in one flex
          row. Compact: stacked — [price · supply] inline above the collect
          button — because the price/supply box's 56px min-widths combined
          (112px) overflow a ~130px-wide compact card. */}
      {compact ? (
        <div className="px-2 pb-2 flex flex-col gap-1">
          {!hidePriceSupply && owned === 0 && !collected && (
            <div className="flex items-center justify-center gap-1 border border-line px-1.5 py-1">
              <span className="text-[10px] font-mono accent-grad truncate">{price ?? '…'}</span>
              <span className="text-[10px] font-mono text-faint">·</span>
              <span className="text-[10px] font-mono text-[#444] truncate">
                {maxSupply === undefined
                  ? '…'
                  : isOpenEdition(maxSupply)
                    ? 'open'
                    : maxSupply.toLocaleString()}
              </span>
            </div>
          )}
          {showProfileCta ? (
            renderViewProfile('compact')
          ) : owned > 0 ? (
            <ListButton
              collectionAddress={moment.address}
              tokenId={moment.token_id}
              name={meta.name}
              image={meta.image ? resolveUri(meta.image) : undefined}
              creatorAddress={moment.creator?.address}
              contentUri={meta.content?.uri}
              contentMime={meta.content?.mime}
            />
          ) : (
            <button
              onClick={handleCollect}
              disabled={collecting || mintedOut || !collectReady}
              className={`w-full py-1.5 text-[10px] font-mono tracking-wider uppercase border transition-colors disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
                hasCollected
                  ? 'text-accent bg-accent/10 border-accent hover:bg-accent/20'
                  : 'text-muted border-line accent-grad-hover'
              }`}
            >
              {collectLabel}
            </button>
          )}
        </div>
      ) : (
        <div className="px-4 pb-4 flex gap-2 items-stretch">
          {!showProfileCta && !hidePriceSupply && owned === 0 && !collected && (
            <div className="flex border border-line flex-none">
              <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
              <div className="border-l border-line px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
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
          {showProfileCta ? (
            renderViewProfile('full')
          ) : owned > 0 ? (
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
          ) : null}
          <button
            onClick={handleCollect}
            disabled={collecting || mintedOut || !collectReady}
            className={`flex-1 ${hidePriceSupply ? 'py-2' : 'py-2.5'} text-xs font-mono tracking-wider uppercase border transition-colors disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
              hasCollected
                ? 'text-accent bg-accent/10 border-accent hover:bg-accent/20'
                : 'text-muted border-line accent-grad-hover transition-all'
            }`}
          >
            {collectLabel}
          </button>
        </div>
      )}
    </article>
  )
}

export const MomentCard = memo(MomentCardImpl)
