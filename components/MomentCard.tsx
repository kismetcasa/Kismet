'use client'

import { memo, useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Copy, Check, EyeOff, ArrowUpRight, Pin } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import {
  resolveUri,
  formatPrice,
  shortAddress,
  inferCollectCurrency,
  DEFAULT_COLLECT_COMMENT,
  type Moment,
} from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent, fetchTextContent } from '@/lib/textCache'
import { getCachedComments, setCachedComments } from '@/lib/momentCache'
import { FeatureStar } from './FeatureStar'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { ListButton } from './ListButton'
import { SaleWindow } from './SaleWindow'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { setVideoDuration } from '@/lib/media/durationCache'
import { ProfileAvatar } from './ProfileAvatar'
import { useInViewDwell } from '@/hooks/useInViewDwell'
import { useMomentSale } from '@/hooks/useMomentSale'

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
  /**
   * Owner-only "pin to profile" affordance. When `onTogglePin` is provided
   * (ProfileView passes it only on the owner's own profile) a pushpin button
   * overlays the image bottom-left; `pinned` drives its filled/outline state.
   * Visitors never receive these, so the React.memo equality (and the price/
   * collection lookups) stay intact for every feed and non-owner profile.
   */
  pinned?: boolean
  onTogglePin?: () => void
  /**
   * Device class (server-detected `isMobile`). When `false` (desktop) the GIF
   * dwell-gate below is skipped, so desktop animates GIFs immediately instead
   * of holding the static thumbhash until the card settles in view — an
   * iOS-memory mitigation desktop doesn't need. Absent ⇒ treated as mobile.
   */
  isMobile?: boolean
  /**
   * Forward to MomentImage: skip the next/image optimizer and go straight to
   * the (downscaling) /api/img proxy. Set for known-heavy covers — e.g. the
   * Patron Collection's physical-artwork scans — whose source 413s the
   * optimizer anyway, so the wasted 413 round-trip (and its blink) is avoided.
   */
  preferProxy?: boolean
}

// Memoized — feeds render 18+ cards each doing 3-5 async lookups, so a
// parent re-render would otherwise re-run them all. Default shallow
// compare works: `moment` is stable across renders (held in parent
// useState arrays); other props are primitives.
function MomentCardImpl({ moment, hidePriceSupply, priority, compact, showCreator, fillCell, passBadge, profileCta, pinned, onTogglePin, isMobile, preferProxy }: MomentCardProps) {
  // Default: creator chip follows compact mode (visible non-compact,
  // hidden compact). `showCreator` overrides either direction.
  const renderCreator = showCreator ?? !compact
  const router = useRouter()
  // Dedups onMouseEnter prefetches per card identity — without this every
  // re-entry refires comments + text + route prefetches.
  const prefetchedRef = useRef<string>('')
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)
  // Card root — observed by the in-view dwell gate that drives the lazy
  // price/RPC reads below.
  const articleRef = useRef<HTMLElement>(null)
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
  const { address: connectedAddress } = useAccount()
  const ensureConnected = useEnsureConnected()
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'
  // The "hidden" badge is a creator-self affordance — only the creator viewing
  // their OWN work should see that one of their moments is hidden (so they can
  // open it and unhide). `moment.hidden` can otherwise arrive true straight from
  // the upstream feed (Kismet only legitimately sets it in the creator's own
  // timeline view, and drops hidden moments from public feeds entirely), so
  // trusting the flag alone leaks the badge into public/featured feeds. Gate on
  // own-moment so the badge means what it was designed to, regardless of source.
  const isOwnMoment =
    !!connectedAddress &&
    moment.creator.address.toLowerCase() === connectedAddress.toLowerCase()

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

  // Gate the per-card price read + the two on-chain reads on an in-view dwell:
  // they fire only once the card has settled within ~200px of the viewport for
  // ~150ms. A fast flick never trips the dwell, so cards the user scrolls
  // straight past do zero network + zero RPC — this is what keeps the feed from
  // breaking on a fast scroll. (Replaces the old blind requestIdleCallback /
  // setTimeout(300) that fired for every mounted card and degraded to a fixed
  // timer on iOS, where requestIdleCallback is unsupported.)
  const inView = useInViewDwell(articleRef, { rootMargin: '200px', dwellMs: 150 })

  const { data: ownedBalance, refetch: refetchOwnedBalance } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    // staleTime: a scroll-back remount reads the cached balance instead of
    // re-issuing the (multicall-batched) eth_call. Collect explicitly refetches
    // after a successful mint, so ownership never goes stale.
    query: { enabled: inView && !!connectedAddress, staleTime: 30_000 },
  })
  const owned = ownedBalance ? Number(ownedBalance) : 0

  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(moment.token_id)],
    query: { enabled: inView, staleTime: 30_000 },
  })
  const maxSupply = tokenInfo?.maxSupply
  const totalMinted = tokenInfo?.totalMinted

  const meta = moment.metadata ?? {}

  // Show the collection name only when this moment belongs to a real
  // collection — one created via the Create Collection flow, or an existing
  // collection minted into. An individual mint auto-deploys a wrapper named
  // after its single piece; that isn't a real collection, so its chip shows
  // the icon only. Server-enriched surfaces carry the explicit flag; on the
  // client-fetch path /api/collections?address already returns a name only
  // for blessed collections, so a name present there is curated by definition.
  const isCuratedCollection = moment.kismetCollection?.isCuratedCollection ?? true

  // Price + currency. hidePriceSupply only controls badge rendering — compact
  // contexts still need these values to drive collect.
  //
  // saleConfig source, in priority order:
  //   1. moment.saleConfig — the fast path when a caller (or a future warm-
  //      cache enrichment) stitched it. /api/timeline does NOT today, so feed
  //      cards fall through to (2).
  //   2. useMomentSale — a dwell-gated react-query read that coalesces every
  //      visible card's request into one /api/moments batch call (see
  //      hooks/useMomentSale): cached, deduped, and only fired once the card
  //      has dwelt in view, so a fast scroll past never fetches.
  const { data: saleData } = useMomentSale(
    moment.address,
    moment.token_id,
    inView && !moment.saleConfig,
  )
  // Display price only — the collect action reads the authoritative price
  // on-chain at click time (see useDirectCollect), so the button never
  // depends on this best-effort fetch resolving.
  const price = useMemo<string | null>(() => {
    const sc = moment.saleConfig ?? saleData ?? null
    if (!sc) return null
    try {
      return formatPrice(sc.pricePerToken, inferCollectCurrency(sc))
    } catch {
      // Malformed pricePerToken — show no price rather than throw.
      return null
    }
  }, [moment.saleConfig, saleData])

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
    // Resolve a connected wallet (host wallet inside a Mini App, RainbowKit
    // picker on web); null = not yet connected. See useEnsureConnected.
    const account = await ensureConnected()
    if (!account) return
    // No price passed — the hook reads the live sale on-chain (authoritative).
    const result = await collect({
      collectionAddress: moment.address as `0x${string}`,
      tokenId: moment.token_id,
      amount: 1,
      comment: DEFAULT_COLLECT_COMMENT,
      // Post-collect share prompt (Mini App only — the hook gates). creatorName
      // is the display fallback; the share flow re-resolves the creator's raw
      // FC username for a real @mention (see lib/collectShare).
      share: {
        momentName: meta.name ?? null,
        creatorAddress: moment.creator.address,
        creatorName,
      },
    })
    if (result) {
      setCollected(true)
      refetchOwnedBalance().catch(() => {})
      refetchTokenInfo().catch(() => {})
    }
  }
  const hasCollected = collected || owned > 0
  // Wait for both reads before flagging — otherwise we'd flash "sold out"
  // before tokenInfo lands.
  const mintedOut =
    maxSupply !== undefined &&
    totalMinted !== undefined &&
    !isOpenEdition(maxSupply) &&
    totalMinted >= maxSupply
  // Sale-window gating. saleStart/saleEnd are unix-second strings on the
  // active sale config; absent, "0", or the max-uint64 sentinel mean "no
  // bound". A scheduled mint isn't collectible until it opens; a closed one
  // isn't after it ends. Number() fails open (NaN → no bound) so malformed
  // data never wrongly blocks collect. Mirrors the mintedOut disable pattern.
  const saleNowSec = Math.floor(Date.now() / 1000)
  const activeSale = moment.saleConfig ?? saleData ?? null
  const saleStartNum = activeSale?.saleStart ? Number(activeSale.saleStart) : 0
  const saleEndNum = activeSale?.saleEnd ? Number(activeSale.saleEnd) : 0
  const saleNotStarted = Number.isFinite(saleStartNum) && saleStartNum > saleNowSec
  const saleEnded = Number.isFinite(saleEndNum) && saleEndNum > 0 && saleEndNum <= saleNowSec
  const collectLabel = collecting
    ? 'collecting…'
    : saleNotStarted
      ? 'not started'
      : saleEnded
        ? 'mint ended'
        : mintedOut
          ? 'sold out'
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
  // Seed the duration cache for InlineVideo to read before it mounts.
  // CRITICAL: key on media.src — the exact raw ar://|ipfs:// URI that
  // InlineVideo reads back with (getVideoDuration(src)). The old key
  // resolveUri(meta.animation_url) produced the resolved https gateway
  // URL, which never matched media.src, so isLongForm was permanently
  // false and long-form videos were stuck on preload="metadata" + loop
  // (the resume-position-survives behavior never engaged). media.src also
  // covers content.uri-only videos that have no animation_url set.
  // Idempotent (same key+value) so re-renders are free; skipped for
  // non-video and for moments lacking the server-stitched duration.
  if (isVideo && media.src && moment.kismet_duration_sec) {
    setVideoDuration(media.src, moment.kismet_duration_sec)
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
      ref={articleRef}
      className={`group flex flex-col bg-[#161616] border border-line overflow-hidden${fillCell && compact ? ' h-full' : ''}`}
    >
      {/* Media — wrapped in <Link> so the click triggers Next.js's
          intercepting route at app/@modal/(.)moment/.../page.tsx. The
          feed stays mounted; the detail page renders as an overlay
          above, with the card's inline video still playing underneath.
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
        {/* Feature control (admin-only; FeatureStar self-gates). Tap to
            feature, hold to set as a Mint Pass Display. Sits inside the
            <Link>; the button's own pointer handlers stop navigation. */}
        <FeatureStar
          address={moment.address}
          tokenId={moment.token_id}
          className="absolute top-1.5 left-1.5"
        />
        {isOwnMoment && moment.hidden && (
          <span className="absolute top-2 right-2 z-10 p-1 bg-[#0d0d0d]/80 border border-line">
            <EyeOff size={10} className="text-muted" />
          </span>
        )}
        {/* Owner-only "pin to profile" toggle. Bottom-left — the one image
            corner no other overlay claims (admin star = top-left, hidden
            badge = top-right, valid-Pass = bottom-right). preventDefault
            stops the wrapping <Link> from navigating on tap. */}
        {onTogglePin && (
          <button
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onTogglePin()
            }}
            className={`absolute bottom-1.5 left-1.5 z-10 min-w-9 min-h-9 flex items-center justify-center transition-colors ${
              pinned ? 'text-accent' : 'text-faint hover:text-dim'
            }`}
            title={pinned ? 'Unpin from profile' : 'Pin to profile'}
            aria-label={pinned ? 'Unpin from profile' : 'Pin to profile'}
          >
            <Pin size={15} fill={pinned ? 'currentColor' : 'none'} strokeWidth={1.5} />
          </button>
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
            title="Grants mint access"
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
          // Animated GIFs decode continuously on iOS (no pause) and pin memory
          // even off-screen — a primary OOM-crash contributor. On MOBILE, while
          // a GIF card isn't settled in view, show the static thumbhash so
          // scrolling / off-screen GIFs hold no decoder; the animated GIF
          // remounts (warm from cache) when the card settles back. Desktop has
          // no such budget (isMobile === false) so it animates immediately.
          // Static images are cheap (optimized, no animation) and aren't gated.
          media.kind === 'gif' && !inView && isMobile !== false ? (
            blurPreview ? (
              <span
                aria-hidden
                className="absolute inset-0 bg-cover bg-center"
                style={{ backgroundImage: `url(${blurPreview})` }}
              />
            ) : (
              <span aria-hidden className="absolute inset-0 bg-accent/10 animate-pulse" />
            )
          ) : (
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
              preferProxy={preferProxy}
            />
          )
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
        {/* Collection chip. The name shows only for a real collection
            (isCuratedCollection) — created, or minted into. An individual
            mint's auto-deploy wrapper shows the icon only, keeping it as a
            clickable affordance into /collection. The chip is suppressed
            entirely only when there's nothing left to show (no name to show
            AND no icon to render), so the slot never becomes an empty
            clickable sliver. */}
        {!compact && collectionName && (isCuratedCollection || (collectionImage && !collectionImageFailed)) && (
          <Link
            href={`/collection/${moment.address}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 group/collection w-fit"
            title={collectionName}
            aria-label={collectionName}
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
            {isCuratedCollection && (
              <span className="text-xs text-muted font-mono group-hover/collection:text-dim transition-colors">
                {collectionName}
              </span>
            )}
          </Link>
        )}
        {/* Sale-window badge — the absolute date the feed answers WHEN with
            (the collect button only gates on it): "Opens Jul 3" for a scheduled
            drop, "Sale ends Jul 8, 5:00 PM" for a live one with an end, "Ended …"
            once closed. Compact cards show date-only; tap through for the time.
            Hidden for live open-ended sales (no date to show). */}
        <SaleWindow saleConfig={activeSale} variant="card" compact={compact} />
      </div>

      {/* Actions row. Default: [price|supply] [list] [collect] in one flex
          row. Compact: stacked — [price · supply] inline above the collect
          button — because the price/supply box's 56px min-widths combined
          (112px) overflow a ~130px-wide compact card. mt-auto pins the row to
          the card's bottom so equal-height grid rows keep their actions
          aligned (no-op when the card isn't stretched). */}
      {compact ? (
        <div className="px-2 pb-2 flex flex-col gap-1 mt-auto">
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
              stacked
            />
          ) : (
            <button
              onClick={handleCollect}
              disabled={collecting || mintedOut || saleNotStarted || saleEnded}
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
        <div className="px-4 pb-4 flex gap-2 items-stretch mt-auto">
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
            disabled={collecting || mintedOut || saleNotStarted || saleEnded}
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
