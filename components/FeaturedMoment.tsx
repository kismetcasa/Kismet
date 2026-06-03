'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { shortAddress, type MomentDetail } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { FeatureStar } from './FeatureStar'

interface FeaturedMomentProps {
  address: string
  tokenId: string
  /** Above-the-fold hint — the hero leads the featured tab and is the LCP. */
  priority?: boolean
}

// Fixed showcase height (≈ a CollectionRow). Desktop-only by construction —
// FeaturedFeed renders this only on web; on mobile/miniapp the mint shows as a
// normal card — so there's no responsive layout here.
const DESKTOP_H = 560
const DEFAULT_RATIO = 1
const MIN_RATIO = 0.5
const MAX_RATIO = 2.0
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
// Box background — a soft yellow-cream off-white. One knob to tune.
const DISPLAY_BG = '#faf6c4'

/**
 * Mint Pass Display — the single curated desktop hero atop the featured tab.
 * A three-column band: [title · by · @artist] | artwork | [collection], on a
 * soft cream box with black text. The artwork is centered and sized to its own
 * aspect ratio (no crop, no letterbox).
 *
 * Click targets: the @artist goes to the artist's profile; clicking anywhere
 * else on the left (or the artwork) opens the moment; the right text opens the
 * collection.
 *
 * Self-contained: fetches the mint by address/tokenId, so it renders whether
 * or not the mint is a standalone featured-timeline entry. Renders nothing if
 * the moment fails to load or is hidden.
 */
export function FeaturedMoment({ address, tokenId, priority }: FeaturedMomentProps) {
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
  useEffect(() => {
    if (!creatorAddress) return
    setArtist(creatorUsername ? `@${creatorUsername}` : shortAddress(creatorAddress))
    fetchCreatorProfile(creatorAddress)
      .then(({ name }) => {
        const isUsername = !!name && name !== shortAddress(creatorAddress)
        setArtist(isUsername ? `@${name}` : shortAddress(creatorAddress))
      })
      .catch(() => {})
  }, [creatorAddress, creatorUsername])

  // Collection label — falls back to the short contract address.
  useEffect(() => {
    fetchCollectionChip(address)
      .then(({ name }) => setCollection(name ?? shortAddress(address)))
      .catch(() => setCollection(shortAddress(address)))
  }, [address])

  const meta = detail?.metadata ?? {}
  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(() => thumbhashToBlurDataURL(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const thumbRatio = useMemo(() => thumbhashToRatio(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)

  // Exact natural ratio (once the image loads) wins; the thumbhash ratio is the
  // shift-free initial guess; square is the pre-data fallback.
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  if (failed || detail?.hidden) return null
  const loading = !detail
  const momentHref = `/moment/${address}/${tokenId}`
  const profileHref = creatorAddress ? `/profile/${creatorAddress}` : undefined
  const title = meta.name ?? `#${tokenId}`

  return (
    <article
      className="relative flex border border-line overflow-hidden"
      style={{ height: DESKTOP_H, backgroundColor: DISPLAY_BG }}
    >
      {/* Left — click anywhere opens the moment; the @artist opens the artist. */}
      <div
        onClick={() => router.push(momentHref)}
        className="flex-1 min-w-0 flex flex-col items-center justify-center text-center gap-1.5 px-6 cursor-pointer hover:bg-black/5 transition-colors"
      >
        {loading ? (
          <span aria-hidden className="h-5 w-2/3 bg-black/10 animate-pulse" />
        ) : (
          <>
            <span className="font-mono text-[#0d0d0d] text-lg xl:text-xl leading-snug line-clamp-3">
              {title}
            </span>
            {artist && (
              <>
                <span className="font-mono text-[#666] text-xs">by</span>
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

      {/* Center — artwork, sized to its own ratio. max-w caps it so the
          flanking text always has room; a too-wide piece on a narrow desktop
          letterboxes (object-contain) instead of overflowing the row. */}
      <Link
        href={momentHref}
        className="relative flex-shrink-0 max-w-[70%] block"
        style={{ width: `calc(${DESKTOP_H}px * ${aspectRatio})`, height: DESKTOP_H, backgroundColor: DISPLAY_BG }}
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
            <span className="text-[10px] font-mono text-[#666] uppercase tracking-widest mb-3">writing</span>
            {meta.name && <p className="text-xl font-mono text-[#0d0d0d] mb-3 truncate">{meta.name}</p>}
            {textSnippet && (
              <p className="text-sm font-mono text-[#444] leading-relaxed whitespace-pre-wrap">{textSnippet}</p>
            )}
          </div>
        ) : blurPreview ? (
          <span aria-hidden className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${blurPreview})` }} />
        ) : loading ? (
          <span aria-hidden className="absolute inset-0 bg-black/5 animate-pulse" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-[#666] font-mono text-xs">no preview</span>
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
          <span aria-hidden className="h-4 w-1/2 bg-black/10 animate-pulse" />
        ) : collection ? (
          <span className="font-mono text-[#0d0d0d] text-base xl:text-lg leading-snug line-clamp-3 hover:underline">
            {collection}
          </span>
        ) : null}
      </Link>
    </article>
  )
}
