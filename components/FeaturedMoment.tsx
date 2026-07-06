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
import { isPatronCollection } from '@/lib/patronCollection'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { MomentCard } from './MomentCard'
import { FeatureStar } from './FeatureStar'

interface FeaturedMomentProps {
  address: string
  tokenId: string
  /** Above-the-fold hint — the hero leads the featured tab and is the LCP. */
  priority?: boolean
  /** The mint's moment from the featured-timeline payload, when available.
   *  Seeds the artwork (image / thumbhash / ratio) for BOTH presentations so it
   *  paints immediately instead of waiting on the /api/moment round-trip — the
   *  same payload every other feed card already renders from, so the load path
   *  is byte-identical to a normal card. The self-fetch still runs to enrich
   *  (KV-corrected creator, saleConfig). Undefined when the mint only lives
   *  inside a featured collection (never a standalone timeline entry); then both
   *  presentations wait on the self-fetch, exactly as before. */
  initialMoment?: Moment
  /** Server-detected mobile UA (SSR-baked in app/page.tsx, so it's stable
   *  through hydration — no post-mount flip). When true we mount ONLY the
   *  below-lg card and skip the lg+ hero entirely. On a phone the hero is
   *  display:none, yet its `priority` artwork STILL preloads (next/image injects
   *  a <link rel=preload> regardless of CSS) and MomentImage force-enables eager
   *  loading inside the miniapp iframe / WebKit (skipDirectWalk). Mounting both
   *  there pulls the heavy painting twice into the iframe's shared, easily
   *  saturated HTTP/2 pool, and the two fetches starve each other — leaving the
   *  visible card a blank, pulsing box (the reported bug). Gating on the SSR
   *  flag mounts exactly one image with no desktop flash — unlike a post-mount
   *  matchMedia gate, which mounted the wrong presentation first and regressed
   *  desktop. */
  isMobile?: boolean
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
const ART_MAX_FRACTION = 0.6
const ART_MAX_W = `${ART_MAX_FRACTION * 100}%`
// Widest the artwork box can ever render, in CSS px — the `sizes` px cap is
// clamped to this so a wide-landscape hero on a big monitor doesn't over-fetch.
// The featured tab's container is max-w-[88rem] with px-4 (DiscoverPage.tsx), so
// the row tops out at 1408 − 32 = 1376px, and the box at ART_MAX_FRACTION of it.
// Kept in sync with that container by hand (no shared token links this JS to the
// Tailwind class, so a change there silently desyncs this). Drift never causes a
// layout bug — this only feeds `sizes` — but it's not free: if the container
// shrinks this over-states the box (over-fetch); if it grows this under-states
// it (a soft LCP, the very failure this fix targets). At worst a mis-sized LCP.
const FEED_ROW_MAX_W = 1408 - 32
const HERO_MAX_W = Math.round(ART_MAX_FRACTION * FEED_ROW_MAX_W)
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

// Where a credited override's profile link should point — the artist's real
// Kismet profile, which differs from the on-chain creator (the platform
// treasury). Keyed by the same creator address as CREDIT_OVERRIDES.
const CREDIT_PROFILE_OVERRIDES: Record<string, string> = {
  '0x099b9bbe0937428e145a3003ddf58e7e0cf69801': '0x6c1cbe8cfc32a74188a9d3bf364945ea53b01b04',
}

/**
 * Mint Pass Display — the single curated mint atop the featured tab, in two
 * presentations:
 *   • lg and up → a rich three-column hero: [title · by · @artist] | artwork |
 *     [collection] on a soft-gold box, the box hugging the artwork's aspect
 *     ratio (no crop, no letterbox) with the flanking columns matching height.
 *   • below lg  → an ordinary <MomentCard>, identical to any other feed card.
 *
 * On desktop both are mounted and `hidden lg:flex` / `lg:hidden` CSS-toggle
 * between them as the window resizes — the hidden card stays lazy, so it never
 * fetches its artwork while the hero is the visible one. On mobile (the SSR
 * `isMobile` flag) only the card mounts; the hero is skipped so its `priority`
 * artwork can't preload behind display:none and starve the visible card's fetch
 * in the miniapp's shared connection pool. See the `isMobile` prop doc.
 *
 * Hero click targets: the @artist opens the artist's profile; clicking anywhere
 * else on the left (or the artwork) opens the moment; the right text opens the
 * collection.
 *
 * Self-contained: fetches the mint once by address/tokenId to enrich it, so it
 * renders whether or not the mint is a standalone featured-timeline entry. When
 * `initialMoment` is supplied the artwork paints from it immediately and the
 * fetch only fills in the rest. Renders nothing if the moment fails to load
 * (with no `initialMoment` fallback) or is hidden.
 */
export function FeaturedMoment({ address, tokenId, priority, initialMoment, isMobile, onResolved }: FeaturedMomentProps) {
  const router = useRouter()
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [failed, setFailed] = useState(false)
  // A moment resolves to one media kind, so a single failure flag (set by
  // whichever of the image/video branches exhausts its gateways) covers both.
  const [mediaError, setMediaError] = useState(false)
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)
  const [artist, setArtist] = useState<string | null>(null)
  const [collection, setCollection] = useState<string | null>(null)

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

  // Collection label — falls back to the short contract address. Hero-only: the
  // right column reads `collection`, and the mobile <MomentCard> resolves its
  // own chip. So skip the fetch + re-render on mobile, where the hero never
  // mounts (the `isMobile` early return below). SSR-stable flag, so a desktop
  // device never wrongly skips it.
  useEffect(() => {
    if (isMobile) return
    fetchCollectionChip(address)
      .then(({ name }) => setCollection(name ?? shortAddress(address)))
      .catch(() => setCollection(shortAddress(address)))
  }, [address, isMobile])

  // Hero artwork source. Seed from the featured-timeline moment when present so
  // the lg+ hero paints before /api/moment resolves; `detail` wins once it
  // lands (same token → same image src, so no refetch). `cardMoment` below
  // seeds from the same `initialMoment`, so both presentations paint from one
  // payload — the one every other feed card already uses.
  const meta = detail?.metadata ?? initialMoment?.metadata ?? {}
  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(() => thumbhashToBlurDataURL(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const thumbRatio = useMemo(() => thumbhashToRatio(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  // Hero-only (the text branch in the hero JSX reads it). Pass undefined on
  // mobile so the hook doesn't fetch the writing body for a hero we never mount.
  const textSnippet = useTextContent(!isMobile && isTextMoment ? meta.content?.uri : undefined)

  // Exact natural ratio (once the image loads) wins; the thumbhash ratio is the
  // shift-free initial guess; a landscape guess covers the pre-data window.
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  // Right-size the LCP fetch. The box renders at `min(560px * ratio, 60% of the
  // row)` (the Link style below), and the row is itself max-width-capped, so the
  // box is bounded on BOTH ends: never wider than HERO_MAX_W (~826px) and, for
  // square/portrait, just `560 * ratio` (a square 560px, a 2:3 portrait ~373px).
  // `heroPxCap` mirrors that exact CSS width — `min(560 * ratio, HERO_MAX_W)` —
  // so it tracks the box for every ratio: the `560 * ratio` term binds for
  // square/portrait, the HERO_MAX_W term binds for wide landscape on a large
  // monitor. `sizes` is a CSS-PX hint the browser multiplies by device DPR
  // before snapping up to a srcSet variant, so the cap must be the box's CSS
  // width with NO manual retina factor (#502's `* 2` double-counted DPR — a
  // 560px square became a 1120px cap, ×2 = 2240 → the 3840w variant; dropping it
  // and capping at HERO_MAX_W lands a square on 1200w, a 2:3 portrait on 750w,
  // and a panorama on 1920w at DPR 2 — the box exactly on a full-width row.
  // On a narrow lg viewport (1024–1376px) the row is smaller than its 1376px max,
  // so a wide-landscape hero clamps to HERO_MAX_W and can over-fetch one srcSet
  // step there — bounded, never under-fetched, and unavoidable for an SSR `sizes`
  // string that can't know the live row width). The trailing `60vw` is only the
  // <1024px fallback AND the `vw`
  // token next/image's generator scans to floor the srcSet candidate list (it
  // reads every vw token and takes the smallest); the lg-clause px value is what
  // the browser honours when picking the variant.
  //
  // Cap tracks the LIVE `aspectRatio` (thumbhash guess → exact natural ratio on
  // load), not a frozen guess. The `priority` preload <link> commits to the
  // guess at first render and MomentImage's <Image> key omits `sizes`, so when
  // the natural ratio lands `heroSizes` is patched in place on the live <img>:
  //   • guess UNDER-estimated the ratio → the browser may pull a larger variant
  //     (a second hero fetch). Accepted: that fetch is the correction that keeps
  //     the LCP crisp; pinning to the guess avoids it but leaves the hero
  //     permanently soft. A crisp LCP beats saving a rare re-fetch.
  //   • guess OVER-estimated (notably no-thumbhash → DEFAULT_RATIO 1.5 for a
  //     narrow piece) → the oversized variant is already fetched and the in-place
  //     patch only lowers the cap, which never DOWN-fetches, so those bytes are
  //     spent. Bounded by HERO_MAX_W, and thumbhash (which encodes aspect) makes
  //     guess ≈ true in the common case, so neither path fires for most heroes.
  const heroPxCap = Math.round(Math.min(DESKTOP_H * aspectRatio, HERO_MAX_W))
  const heroSizes = `(min-width: 1024px) ${heroPxCap}px, 60vw`

  // Below-lg presentation: the same mint as an ordinary MomentCard. Before the
  // self-fetch resolves, render the timeline moment as-is so the artwork paints
  // with the rest of the feed instead of lagging a round-trip behind it; once
  // `detail` lands we swap to the enriched version (KV-corrected creator EOA +
  // saleConfig for the fast price path). Same image src either way, so the swap
  // never refetches the artwork. Null only when there's neither — the mint
  // lives solely inside a featured collection and the self-fetch hasn't landed.
  const cardMoment = useMemo<Moment | null>(() => {
    if (!detail) return initialMoment ?? null
    return {
      address,
      token_id: tokenId,
      uri: detail.uri ?? '',
      creator: { address: creatorAddress ?? '', username: creditOverride ?? creatorUsername ?? undefined, hidden: false },
      admins: [],
      created_at: '',
      // Render the artwork from the TIMELINE metadata when we have it — it
      // carries kismet_thumbhash and the exact image src every other feed card
      // uses, and it's ALREADY painting by the time `detail` lands. Swapping to
      // detail.metadata here remounts the <img> mid-load: /api/moment returns
      // the inprocess detail verbatim, whose metadata can resolve a different
      // image src (MomentImage keys its <Image> off the resolved URL, so the
      // element remounts) and can omit kismet_thumbhash (dropping the blur
      // placeholder). In the miniapp's saturated HTTP/2 pool that interrupted
      // refetch stalls and leaves the card a blank box, while the ordinary grid
      // cards — which never swap — render fine. This is what stopped the
      // featured card from "acting like a normal card" on mobile. `detail` still
      // drives price (saleConfig) and the credit-corrected creator below. Falls
      // back to detail.metadata only when there was no timeline seed (the mint
      // lives solely inside a featured collection, so it never had one).
      metadata: initialMoment?.metadata ?? detail.metadata,
      saleConfig: detail.saleConfig,
      // Carry the timeline-stitched chip across the swap. /api/moment doesn't
      // return it, so without this the field would go defined→undefined when we
      // swap off `initialMoment`, re-tripping MomentCard's collection guard
      // (`kismetCollection !== undefined`) into a per-card /api/collections
      // refetch — and, for a curated collection with a null stitched name, a
      // visible chip pop-in mid-view. Undefined when there's no initialMoment
      // (mint only inside a featured collection), so the card fetches once then.
      kismetCollection: initialMoment?.kismetCollection,
    }
  }, [detail, initialMoment, address, tokenId, creatorAddress, creatorUsername, creditOverride])

  // Whether this slot will paint. It returns null just below for a hidden or
  // failed mint; report that up so the feed shows its empty message instead of
  // a blank tab when this display is the only featured content. A failed
  // self-fetch only blanks when there's no timeline moment to fall back on —
  // with `initialMoment` the mint is a real, visible featured entry, so keep
  // rendering it; `detail.hidden` still blanks once known.
  const blank = (failed && !initialMoment) || !!detail?.hidden
  useEffect(() => { onResolved?.(!blank) }, [blank, onResolved])

  if (blank) return null

  // The below-lg card. On mobile this component is only reached as a FALLBACK —
  // when the mint isn't a standalone timeline entry, FeaturedFeed renders this
  // instead of a plain MomentCard (the common mobile path lives there now). On
  // desktop it's the `lg:hidden` duplicate beneath the rich hero.
  //
  // priority={false} on BOTH surfaces:
  //   • Desktop — the hero owns the LCP; this hidden copy must never fetch while
  //     the hero is the visible presentation.
  //   • Mobile — match every other feed card, which renders WITHOUT priority.
  //     `priority` injects a <link rel=preload> that fetches during app bootstrap
  //     and competes with the critical JS/CSS in the miniapp's tiny shared HTTP/2
  //     pool, so the preloaded image LAGS behind the non-preloaded cards (which
  //     fetch after hydration, pool free). MomentImage still force-eagers it in
  //     the miniapp via skipDirectWalk, so it loads eagerly — just without the
  //     counter-productive preload, identical to the others.
  // showCreator follows the resolved artist so the chip drops exactly when the
  // hero drops its @artist line — never a dead /profile/ link.
  const card = cardMoment ? (
    <MomentCard
      moment={cardMoment}
      showCreator={!!creatorAddress}
      priority={false}
      isMobile={isMobile}
      // Patron scans skip the optimizer via MomentCard's own
      // isPatronCollection self-detection — no preferProxy needed here.
    />
  ) : null

  if (isMobile) return card

  const loading = !detail
  const momentHref = `/moment/${address}/${tokenId}`
  const profileHref = creatorAddress
    ? `/profile/${CREDIT_PROFILE_OVERRIDES[creatorAddress.toLowerCase()] ?? creatorAddress}`
    : undefined
  const title = meta.name ?? `#${tokenId}`

  return (
    <>
      {/* Desktop hero — `hidden lg:flex` paints the wide 3-column band only at
          lg and up. Below lg the <MomentCard> after it (`lg:hidden`) shows
          instead, so the viewport alone picks the presentation. */}
      <article
        className="relative hidden lg:flex border border-line overflow-hidden"
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
          href={`/collection/${address}`}
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
              // The hero is the LCP, so for normal art let next/image optimize
              // (AVIF + downscale via `sizes`). But Patron mints are heavy
              // physical-art scans that 413 the optimizer on every load — skip
              // straight to the downscaling proxy so we don't re-pay that doomed
              // round-trip (desktop's pool would mask it, but it's still waste).
              preferProxy={isPatronCollection(address)}
              className="object-contain"
              sizes={heroSizes}
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

      {/* Below lg — the same card, `lg:hidden` to keep it out of the desktop
          view where the hero takes over. display:none + the card's lazy image
          (priority={false}, and not WebKit/iframe on desktop so skipDirectWalk
          doesn't force eager) means it never fetches its artwork here — only the
          hero does. On mobile this branch isn't reached; the card is returned
          on its own above so the hero never mounts to preload a second copy. */}
      {card && <div className="lg:hidden">{card}</div>}
    </>
  )
}
