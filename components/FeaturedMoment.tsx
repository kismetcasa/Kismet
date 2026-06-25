'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { shortAddress, type Moment, type MomentDetail } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { MomentCard } from './MomentCard'
import { FeatureStar } from './FeatureStar'

interface FeaturedMomentProps {
  address: string
  tokenId: string
  /** Above-the-fold hint — the hero leads the featured tab and is the LCP. */
  priority?: boolean
  /** The mint's moment as it already appears in the featured timeline, when
   *  available. Lets the artwork (image + thumbhash + ratio) paint immediately
   *  instead of waiting on the /api/moment round-trip — the reason the featured
   *  artwork lagged every other feed card, which all get their src from the
   *  timeline payload. The self-fetch still runs to enrich (KV-corrected
   *  creator, saleConfig). Undefined when the mint only lives inside a featured
   *  collection (not a standalone timeline entry); then the self-fetch alone
   *  drives it, as before. */
  initialMoment?: Moment
  /** Reports whether this slot paints anything. A configured display still
   *  renders null when its mint is hidden or the fetch fails; the feed uses
   *  this so its empty state shows a message instead of a blank tab then. */
  onResolved?: (hasContent: boolean) => void
}

// Max showcase height; the box shrinks below this so it always hugs the
// artwork (no dead space above/below). Drives the lg+ hero only.
const DESKTOP_H = 560
// Fraction of the row the artwork may occupy, leaving room for the flanking
// text. The artwork takes the smaller of (height × ratio) and this.
const ART_MAX_W = '60%'
// Pre-load guess until the thumbhash (then the image) reports the real shape.
const DEFAULT_RATIO = 1.5
// Safety bounds only — wide enough that no real artwork is clamped (which is
// what would reintroduce letterbox), narrow enough to avoid degenerate boxes.
const MIN_RATIO = 0.2
const MAX_RATIO = 5
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
// Box background — a desaturated dusty pink. Dark text clears ~9:1 on it. One knob.
const DISPLAY_BG = '#d2a9b3'

// Manual credit overrides for the featured mint pass display, keyed by creator
// address (lowercase). Stopgap for artists whose minting wallet has no Kismet
// username or primary ENS set yet — shown verbatim in place of the short
// address. Graduate to an admin-set credit when the need generalizes.
const CREDIT_OVERRIDES: Record<string, string> = {
  '0x099b9bbe0937428e145a3003ddf58e7e0cf69801': 'turro',
}

/**
 * Mint Pass Display — the single curated mint atop the featured tab, rendered
 * in one of two presentations picked by the *viewport* (a matchMedia check, not
 * a UA guess):
 *   • lg and up → a rich three-column hero: [title · by · @artist] | artwork |
 *     [collection] on a soft-gold box, the box hugging the artwork's aspect
 *     ratio (no crop, no letterbox) with the flanking columns matching height.
 *   • below lg  → an ordinary <MomentCard>, identical to any other feed card.
 *
 * Only the matching presentation is MOUNTED (not CSS-toggled). A `hidden`
 * presentation still fetches its artwork — next/image preloads `priority`
 * images, and inside the miniapp iframe / WebKit MomentImage force-enables
 * eager loading (skipDirectWalk) — so rendering both pulls the heavy image
 * twice, and in the iframe's shared, easily-saturated HTTP/2 pool the two
 * fetches starve each other, leaving the visible one a blank box. Mounting one
 * keeps it to a single fetch. Safe to gate in JS: this subtree is client-only
 * (DiscoverPage renders it behind `hydrated`) and the artwork src is itself
 * client-fetched, so the viewport gate adds no SSR/LCP cost.
 *
 * Hero click targets: the @artist opens the artist's profile; clicking anywhere
 * else on the left (or the artwork) opens the moment; the right text opens the
 * collection.
 *
 * Self-contained: fetches the mint once by address/tokenId, so it renders
 * whether or not the mint is a standalone featured-timeline entry. Renders
 * nothing if the moment fails to load or is hidden.
 */
export function FeaturedMoment({ address, tokenId, priority, initialMoment, onResolved }: FeaturedMomentProps) {
  const router = useRouter()
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [failed, setFailed] = useState(false)
  // A moment resolves to one media kind, so a single failure flag (set by
  // whichever of the image/video branches exhausts its gateways) covers both.
  const [mediaError, setMediaError] = useState(false)
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)
  const [artist, setArtist] = useState<string | null>(null)
  const [collection, setCollection] = useState<string | null>(null)
  // Viewport gate (matchMedia, not a UA guess) — picks the single presentation
  // to mount. Defaults to mobile so a phone never fetches the heavy hero
  // artwork; corrected on mount. See the component doc for why only one
  // presentation is mounted.
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)')
    const onChange = () => setIsDesktop(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? (r.json() as Promise<MomentDetail>) : Promise.reject()))
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [address, tokenId])

  // Artist label + profile link. /api/moment resolves creator to the real
  // minter EOA (KV-corrected), so the address here is the artist, not the
  // collection operator. Seed the label from the response, upgrade from the
  // profile cache.
  const creatorAddress = detail?.creator?.address
  const creatorUsername = detail?.creator?.username
  // Manual credit override wins over username/ENS/short-address (stopgap).
  const creditOverride = creatorAddress
    ? CREDIT_OVERRIDES[creatorAddress.toLowerCase()]
    : undefined
  useEffect(() => {
    if (!creatorAddress) return
    if (creditOverride) { setArtist(creditOverride); return }
    setArtist(creatorUsername ? `@${creatorUsername}` : shortAddress(creatorAddress))
    fetchCreatorProfile(creatorAddress)
      .then(({ name }) => {
        const isUsername = !!name && name !== shortAddress(creatorAddress)
        setArtist(isUsername ? `@${name}` : shortAddress(creatorAddress))
      })
      .catch(() => {})
  }, [creatorAddress, creatorUsername, creditOverride])

  // Collection label — falls back to the short contract address.
  useEffect(() => {
    fetchCollectionChip(address)
      .then(({ name }) => setCollection(name ?? shortAddress(address)))
      .catch(() => setCollection(shortAddress(address)))
  }, [address])

  const meta = detail?.metadata ?? initialMoment?.metadata ?? {}
  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(() => thumbhashToBlurDataURL(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const thumbRatio = useMemo(() => thumbhashToRatio(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)

  // Exact natural ratio (once the image loads) wins; the thumbhash ratio is the
  // shift-free initial guess; a landscape guess covers the pre-data window.
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  // Below-lg presentation: the same mint as an ordinary MomentCard, built from
  // the single fetch above. saleConfig is forwarded so the card takes its fast
  // price path and skips a redundant /api/moment round-trip; the creator is the
  // KV-corrected artist EOA (username left to resolve from the profile cache,
  // exactly as the hero's @artist does).
  const cardMoment = useMemo<Moment | null>(() => {
    // Before the self-fetch resolves, render the timeline moment as-is so the
    // artwork paints immediately; once `detail` lands we swap to the enriched
    // version (KV-corrected creator + saleConfig). Same image src, so the swap
    // doesn't refetch the artwork.
    if (!detail) return initialMoment ?? null
    return {
      address,
      token_id: tokenId,
      uri: detail.uri ?? '',
      creator: { address: creatorAddress ?? '', username: creditOverride ?? creatorUsername ?? undefined, hidden: false },
      admins: [],
      created_at: '',
      metadata: detail.metadata,
      saleConfig: detail.saleConfig,
    }
  }, [detail, initialMoment, address, tokenId, creatorAddress, creatorUsername, creditOverride])

  // Whether the hero will paint. It returns null just below for a hidden or
  // failed mint; report that up so the feed shows its empty message instead of
  // a blank tab when this display is the only featured content.
  // A failed self-fetch only blanks the slot when we have no timeline moment to
  // fall back on; with `initialMoment` the mint is a real, visible featured
  // entry, so render it regardless. `detail.hidden` still blanks once known.
  const blank = (failed && !initialMoment) || !!detail?.hidden
  useEffect(() => { onResolved?.(!blank) }, [blank, onResolved])

  if (blank) return null

  // Below lg — the same mint as an ordinary feed card, and the mobile LCP, so
  // forward `priority` (preload + high fetch priority) like the hero. The old
  // priority={false} here was a leftover from when this card was the hidden-on-
  // desktop fallback; it de-prioritized the top artwork below its neighbors.
  // showCreator follows the resolved artist so the chip drops exactly when the
  // hero would drop its @artist line — never a dead /profile/ link.
  if (!isDesktop) {
    return cardMoment ? (
      <MomentCard moment={cardMoment} showCreator={!!creatorAddress} priority={priority} />
    ) : null
  }

  // lg and up — the rich three-column hero.
  const loading = !detail
  const momentHref = `/moment/${address}/${tokenId}`
  const profileHref = creatorAddress ? `/profile/${creatorAddress}` : undefined
  const title = meta.name ?? `#${tokenId}`

  return (
      <article
        className="relative flex border border-line overflow-hidden"
        style={{ backgroundColor: DISPLAY_BG }}
      >
        {/* Left — click anywhere opens the moment; the @artist opens the artist. */}
        <div
          onClick={() => router.push(momentHref)}
          className="flex-1 min-w-0 flex flex-col items-center justify-center text-center gap-1.5 px-6 cursor-pointer hover:bg-black/5 transition-colors"
        >
          {loading ? (
            <span aria-hidden className="h-5 w-2/3 bg-black/15 animate-pulse" />
          ) : (
            <>
              <span className="font-mono text-[#0d0d0d] text-lg xl:text-xl leading-snug line-clamp-3">
                {title}
              </span>
              {artist && (
                <>
                  <span className="font-mono text-black/60 text-xs">by</span>
                  {profileHref ? (
                    <Link
                      href={profileHref}
                      onClick={(e) => e.stopPropagation()}
                      className="font-mono text-[#0d0d0d] text-sm truncate max-w-full hover:underline"
                    >
                      {artist}
                    </Link>
                  ) : (
                    <span className="font-mono text-[#0d0d0d] text-sm truncate max-w-full">{artist}</span>
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Center — artwork, sized to its own ratio so the box hugs it (no dead
            space). Height follows the ratio up to DESKTOP_H; width is capped at
            ART_MAX_W so the flanking text always has room. */}
        <Link
          href={momentHref}
          className="relative flex-none block overflow-hidden"
          style={{
            width: `min(calc(${DESKTOP_H}px * ${aspectRatio}), ${ART_MAX_W})`,
            aspectRatio,
            backgroundColor: DISPLAY_BG,
          }}
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
              // No preferProxy: the hero is the LCP, so let next/image optimize
              // (AVIF/WebP + downscale via `sizes`); MomentImage still falls back
              // to the proxy if the optimizer 413s heavy art.
              className="object-contain"
              sizes="60vw"
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
          ) : loading ? (
            <span aria-hidden className="absolute inset-0 bg-black/10 animate-pulse" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-black/50 font-mono text-xs">no preview</span>
            </div>
          )}

          {/* Admin control — tap to feature, hold to set this Mint Pass Display.
              Its own handlers stop the wrapping link from navigating. */}
          <FeatureStar address={address} tokenId={tokenId} className="absolute top-2 left-2" />
        </Link>

        {/* Right — collection → collection page */}
        <Link
          href={`/collection/${address}`}
          className="flex-1 min-w-0 flex flex-col items-center justify-center text-center gap-1 px-6 hover:bg-black/5 transition-colors"
        >
          {loading ? (
            <span aria-hidden className="h-4 w-1/2 bg-black/15 animate-pulse" />
          ) : collection ? (
            <span className="font-mono text-[#0d0d0d] text-base xl:text-lg leading-snug line-clamp-3 hover:underline">
              {collection}
            </span>
          ) : null}
        </Link>
      </article>
  )
}
