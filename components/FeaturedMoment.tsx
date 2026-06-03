'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { MomentDetail } from '@/lib/inprocess'
import { useTextContent } from '@/lib/textCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { FeatureStar } from './FeatureStar'

interface FeaturedMomentProps {
  address: string
  tokenId: string
  /**
   * Above-the-fold hint. The first Mint Pass Display leads the featured tab,
   * so its artwork is the LCP candidate — forwarded to the media so it loads
   * eagerly instead of behind hydration.
   */
  priority?: boolean
}

// Default frame ratio before the artwork's own ratio is known (square). Kept
// until the thumbhash (and then the full image) report the real shape.
const DEFAULT_RATIO = 1
// Clamp the frame to a sane range so an extreme panorama / column can't blow
// the layout out; within this band the box matches the artwork exactly, so
// object-cover fills with no crop. Beyond it, the rare extreme is cover-cropped.
const MIN_RATIO = 0.5
const MAX_RATIO = 2.0
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))

/**
 * Mint Pass Display — a single mint rendered at collection scale as a
 * full-bleed showcase. The frame hugs the artwork's own aspect ratio (derived
 * from the thumbhash up front, refined to the image's exact natural ratio on
 * load) so the image fills the box as tightly as possible: no letterbox, no
 * crop. The card is image-only — clicking opens the moment's detail overlay
 * (title, creator, collect, …) via the standard intercepting route.
 *
 * Self-contained: fetches its own MomentDetail and renders nothing if the
 * moment fails to load or is hidden, so a stale curation can never leave a
 * broken showcase in the feed.
 */
export function FeaturedMoment({ address, tokenId, priority }: FeaturedMomentProps) {
  const [detail, setDetail] = useState<MomentDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams({
      collectionAddress: address,
      tokenId,
      chainId: '8453',
    })
    fetch(`/api/moment?${params}`)
      .then((r) => (r.ok ? (r.json() as Promise<MomentDetail>) : Promise.reject()))
      .then((d) => { if (!cancelled) setDetail(d) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [address, tokenId])

  const meta = detail?.metadata ?? {}
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

  // Exact natural ratio (once the image loads) wins; the thumbhash ratio is the
  // shift-free initial guess; square is the pre-data fallback.
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  if (failed || detail?.hidden) return null
  const loading = !detail
  const momentHref = `/moment/${address}/${tokenId}`

  return (
    // Centered so a portrait/landscape frame sits balanced in the full-width
    // tab rather than hugging the left edge.
    <div className="flex justify-center">
      {/* Frame: full-width & ratio-driven height on mobile; fixed collection-
          scale height & ratio-driven width on desktop. Either way the box ==
          the artwork's shape, so the media fills it edge-to-edge. */}
      <article
        className="relative w-full lg:w-auto lg:h-[560px] max-w-full max-h-[85vh] lg:max-h-none bg-[#161616] border border-line overflow-hidden group"
        style={{ aspectRatio }}
      >
        <Link href={momentHref} className="absolute inset-0 block bg-surface" aria-label={meta.name ?? `moment #${tokenId}`}>
          {isVideo && media.src && !videoError ? (
            <MomentVideo
              src={media.src}
              poster={media.poster}
              thumbhash={meta.kismet_thumbhash}
              showPosterLayer
              className="w-full h-full object-cover"
              priority={priority}
              onAllError={() => setVideoError(true)}
            />
          ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !imgError ? (
            <MomentImage
              src={media.src}
              alt={meta.name ?? 'moment'}
              fill
              className="object-cover"
              sizes="(max-width: 1024px) 100vw, 80vw"
              mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
              thumbhash={meta.kismet_thumbhash}
              priority={priority}
              preferProxy
              onNaturalSize={handleNaturalSize}
              onAllError={() => setImgError(true)}
            />
          ) : isTextMoment ? (
            <div className="w-full h-full flex flex-col p-6 sm:p-10 bg-gradient-to-br from-raised to-surface overflow-hidden">
              <span className="text-[10px] font-mono text-muted uppercase tracking-widest mb-3">writing</span>
              {meta.name && (
                <p className="text-base sm:text-xl font-mono text-ink mb-3 truncate">{meta.name}</p>
              )}
              {textSnippet && (
                <p className="text-sm sm:text-base font-mono text-[#bbb] leading-relaxed whitespace-pre-wrap">
                  {textSnippet}
                </p>
              )}
              {!meta.name && !textSnippet && (
                <p className="text-sm font-mono text-[#bbb]">untitled</p>
              )}
            </div>
          ) : blurPreview ? (
            <span
              aria-hidden
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: `url(${blurPreview})` }}
            />
          ) : loading ? (
            <span aria-hidden className="absolute inset-0 bg-accent/10 animate-pulse" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-line font-mono text-xs">no preview</span>
            </div>
          )}
        </Link>

        {/* Admin feature control — tap to feature, hold to toggle this Mint
            Pass Display. Sibling above the link so its taps never navigate. */}
        <FeatureStar address={address} tokenId={tokenId} className="absolute top-2 left-2" />
      </article>
    </div>
  )
}
