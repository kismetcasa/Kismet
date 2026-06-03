'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
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
// FeaturedFeed renders this only on web; on mobile/miniapp the same mint rides
// the featured grid as a normal card — so there's no responsive layout here.
const DESKTOP_H = 560
const DEFAULT_RATIO = 1
// Bound the artwork so an extreme panorama/column can't starve the flanking
// text columns. Within the band the box matches the artwork exactly, so
// object-contain fills it with no letterbox; beyond it the whole piece still
// shows, letterboxed, never cropped.
const MIN_RATIO = 0.5
const MAX_RATIO = 2.0
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))

/**
 * Mint Pass Display — the single curated desktop hero atop the featured tab.
 * A three-column band: [title · by · @artist] | artwork | [collection]. The
 * artwork is centered and sized to its own aspect ratio (no crop, no
 * letterbox); the left text links to the moment detail page and the right
 * text to the collection page.
 *
 * Self-contained: fetches its own MomentDetail and resolves the artist /
 * collection labels from the shared caches. Holds a fixed-height skeleton
 * while loading and renders nothing if the moment fails to load or is hidden,
 * so a stale curation never leaves a broken hero in the feed.
 */
export function FeaturedMoment({ address, tokenId, priority }: FeaturedMomentProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)
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

  // Artist label — `@username` when resolvable, else the short address. Seed
  // from the /api/moment creator, then upgrade from the Kismet profile cache.
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
  const title = meta.name ?? `#${tokenId}`

  return (
    <article
      className="relative flex border border-line bg-[#161616] overflow-hidden"
      style={{ height: DESKTOP_H }}
    >
      {/* Left — title · by · artist → moment detail */}
      <Link
        href={momentHref}
        className="group/l flex-1 min-w-0 flex flex-col items-center justify-center text-center gap-1.5 px-6"
      >
        {loading ? (
          <span aria-hidden className="h-5 w-2/3 bg-line/50 animate-pulse" />
        ) : (
          <>
            <span className="font-mono text-ink text-lg xl:text-xl leading-snug line-clamp-3 group-hover/l:text-dim transition-colors">
              {title}
            </span>
            {artist && (
              <>
                <span className="font-mono text-muted text-xs">by</span>
                <span className="font-mono text-dim text-sm truncate max-w-full group-hover/l:text-ink transition-colors">
                  {artist}
                </span>
              </>
            )}
          </>
        )}
      </Link>

      {/* Center — artwork, sized to its own ratio. max-w caps it so the
          flanking text always has room; a too-wide piece on a narrow desktop
          letterboxes (object-contain) instead of overflowing the row. */}
      <div
        className="relative flex-shrink-0 bg-surface max-w-[70%]"
        style={{ width: `calc(${DESKTOP_H}px * ${aspectRatio})`, height: DESKTOP_H }}
      >
        {isVideo && media.src && !videoError ? (
          <MomentVideo
            src={media.src}
            poster={media.poster}
            thumbhash={meta.kismet_thumbhash}
            showPosterLayer
            className="w-full h-full object-contain"
            priority={priority}
            onAllError={() => setVideoError(true)}
          />
        ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !imgError ? (
          <MomentImage
            src={media.src}
            alt={title}
            fill
            className="object-contain"
            sizes="60vw"
            mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
            thumbhash={meta.kismet_thumbhash}
            priority={priority}
            preferProxy
            onNaturalSize={handleNaturalSize}
            onAllError={() => setImgError(true)}
          />
        ) : isTextMoment ? (
          <div className="w-full h-full flex flex-col p-8 bg-gradient-to-br from-raised to-surface overflow-hidden">
            <span className="text-[10px] font-mono text-muted uppercase tracking-widest mb-3">writing</span>
            {meta.name && <p className="text-xl font-mono text-ink mb-3 truncate">{meta.name}</p>}
            {textSnippet && (
              <p className="text-sm font-mono text-[#bbb] leading-relaxed whitespace-pre-wrap">{textSnippet}</p>
            )}
          </div>
        ) : blurPreview ? (
          <span aria-hidden className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${blurPreview})` }} />
        ) : loading ? (
          <span aria-hidden className="absolute inset-0 bg-accent/10 animate-pulse" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-xs">no preview</span>
          </div>
        )}

        {/* Admin control — tap to feature, hold to set this Mint Pass Display. */}
        <FeatureStar address={address} tokenId={tokenId} className="absolute top-2 left-2" />
      </div>

      {/* Right — collection → collection page */}
      <Link
        href={`/collection/${address}`}
        className="group/r flex-1 min-w-0 flex flex-col items-center justify-center text-center gap-1 px-6"
      >
        {loading ? (
          <span aria-hidden className="h-4 w-1/2 bg-line/50 animate-pulse" />
        ) : collection ? (
          <span className="font-mono text-ink text-base xl:text-lg leading-snug line-clamp-3 group-hover/r:text-dim transition-colors">
            {collection}
          </span>
        ) : null}
      </Link>
    </article>
  )
}
