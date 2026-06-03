'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { shortAddress, type Moment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useTextContent } from '@/lib/textCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { FeatureStar } from './FeatureStar'

interface FeaturedMomentProps {
  /**
   * The hero mint — passed straight from FeaturedFeed's already-fetched
   * featured timeline (the display mint is also in FEATURED_KEY). The Moment
   * is server-enriched with creator + collection chip + inline metadata, so
   * this component needs no fetch of its own.
   */
  moment: Moment
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
 * Presentational: the Moment is handed in fully-formed, so there's no fetch,
 * loading, or hidden-gating here (the timeline already filtered hidden mints).
 */
export function FeaturedMoment({ moment, priority }: FeaturedMomentProps) {
  const { address, token_id: tokenId } = moment
  const meta = moment.metadata ?? {}
  const [mediaError, setMediaError] = useState(false)
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)

  // Artist label — seeded from the server-enriched Moment so it paints
  // immediately, then upgraded from the profile cache for FC-only creators
  // whose username isn't stitched server-side.
  const creatorAddress = moment.creator?.address
  const seedArtist = creatorAddress
    ? moment.creator?.username
      ? `@${moment.creator.username}`
      : shortAddress(creatorAddress)
    : null
  const [resolvedArtist, setResolvedArtist] = useState<string | null>(null)
  const artist = resolvedArtist ?? seedArtist
  useEffect(() => {
    if (!creatorAddress || moment.creator?.username) return
    fetchCreatorProfile(creatorAddress)
      .then(({ name }) => {
        const isUsername = !!name && name !== shortAddress(creatorAddress)
        setResolvedArtist(isUsername ? `@${name}` : shortAddress(creatorAddress))
      })
      .catch(() => {})
  }, [creatorAddress, moment.creator?.username])

  // Collection label — the timeline already stitches the chip; fall back to
  // the short contract address.
  const collection = moment.kismetCollection?.name ?? shortAddress(address)

  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const isTextMoment = media.kind === 'text'
  const blurPreview = useMemo(() => thumbhashToBlurDataURL(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const thumbRatio = useMemo(() => thumbhashToRatio(meta.kismet_thumbhash), [meta.kismet_thumbhash])
  const textSnippet = useTextContent(isTextMoment ? meta.content?.uri : undefined)

  // Exact natural ratio (once the image loads) wins; the thumbhash ratio is the
  // shift-free initial guess; square is the fallback.
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

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
      </Link>

      {/* Center — artwork, sized to its own ratio. max-w caps it so the
          flanking text always has room; a too-wide piece on a narrow desktop
          letterboxes (object-contain) instead of overflowing the row. */}
      <div
        className="relative flex-shrink-0 bg-surface max-w-[70%]"
        style={{ width: `calc(${DESKTOP_H}px * ${aspectRatio})`, height: DESKTOP_H }}
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
            // No preferProxy: the hero is the LCP, so let next/image optimize
            // (AVIF/WebP + downscale via `sizes`) rather than serving the raw
            // bytes. Matches how the same mint's image is handled in the grid
            // (MomentCard) and the detail view (MomentDetailView); MomentImage
            // still falls back to the proxy if the optimizer 413s heavy art.
            sizes="60vw"
            mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
            thumbhash={meta.kismet_thumbhash}
            priority={priority}
            onNaturalSize={handleNaturalSize}
            onAllError={() => setMediaError(true)}
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
        <span className="font-mono text-ink text-base xl:text-lg leading-snug line-clamp-3 group-hover/r:text-dim transition-colors">
          {collection}
        </span>
      </Link>
    </article>
  )
}
