'use client'

import { useEffect, useMemo, useState } from 'react'
import { isProxiable, proxyUrl } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { MomentImg } from './MomentImage'
import { SharedVideoSlot } from './SharedVideoSlot'

interface MomentVideoProps {
  /** Raw URI for the video media: ar://, ipfs://, or https://. */
  src: string
  /** Optional poster URI. When `showPosterLayer` is on, this renders as
   *  an <img> behind the video slot so the surface paints content the
   *  instant it mounts (thumbhash → /api/img poster → video first frame). */
  poster?: string
  /** Base64 thumbhash — drives the blur placeholder on the poster layer. */
  thumbhash?: string
  /** Render the poster as a static <img> layer behind the video slot.
   *  On for card/modal/detail surfaces; off for the lightbox where the
   *  video sizes itself via max-w/max-h with no relative parent. */
  showPosterLayer?: boolean
  /** Z-index for the persistent video element while this surface owns
   *  it. Default (10) sits above page content; overlay surfaces should
   *  pass a higher value, OR wrap in <SharedVideoZIndexProvider>. */
  zIndex?: number
  /** Show native controls — implies "committed viewing" and disables
   *  the off-screen auto-pause behaviour. Detail page, lightbox. */
  controls?: boolean
  /** className for the slot placeholder (sizing + layout classes you'd
   *  normally pass to <video> directly). */
  className?: string
  /** Fired once every gateway has errored for the video (separate from
   *  poster errors). Parent can swap in a placeholder. */
  onAllError?: () => void
  /** Above-the-fold hint — forwarded to the poster <img>. On video
   *  moments the poster is the LCP candidate (the <video> doesn't paint
   *  until metadata loads). */
  priority?: boolean
}

/**
 * Per-surface "view" of a video moment. Composes:
 *   - Poster image layer (MomentImg, per-surface, cheap to re-mount)
 *   - Thumbhash blur layer (per-surface, instant on paint)
 *   - SharedVideoSlot — anchor for the persistent video element that
 *     lives in the root layout's SharedVideoProvider pool
 *
 * The slot pattern means the actual <video> element survives across
 * route transitions (Plan C). Surfaces unmount; the element doesn't.
 * On the next surface that registers a slot for the same src, the
 * element CSS-positions to overlay the new slot. Same element, same
 * decoder, no re-decode flicker, currentTime preserved natively.
 */
export function MomentVideo({
  src,
  poster,
  thumbhash,
  showPosterLayer,
  zIndex,
  controls,
  className,
  onAllError,
  priority,
}: MomentVideoProps) {
  const blurDataURL = useMemo(() => thumbhashToBlurDataURL(thumbhash), [thumbhash])

  // Per-surface poster degradation. If MomentImg walks all gateways
  // without successfully rendering the URL as an image (e.g. legacy
  // bug where meta.image was set to the video URL itself), drop the
  // image layer and fall through to thumbhash / bare slot.
  const [posterFailed, setPosterFailed] = useState(false)
  useEffect(() => { setPosterFailed(false) }, [poster])

  // Per-surface video failure. The pool walks gateways internally; when
  // all are exhausted it fires onError on the active slot.
  const [videoFailed, setVideoFailed] = useState(false)
  useEffect(() => { setVideoFailed(false) }, [src])

  // Surface the catastrophic "no video AND no poster" case to the
  // parent via onAllError. Done in an effect to avoid a side effect
  // during render.
  useEffect(() => {
    if (videoFailed && (!poster || posterFailed)) onAllError?.()
  }, [videoFailed, posterFailed, poster, onAllError])

  // Shared poster + thumbhash layer used by both the main render and
  // the videoFailed fallback. Extracted to keep the two render paths
  // from drifting.
  const posterLayer = (posterSrc: string) => (
    <>
      {blurDataURL && (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center pointer-events-none"
          style={{ backgroundImage: `url(${blurDataURL})` }}
        />
      )}
      <MomentImg
        src={posterSrc}
        alt=""
        // skipProxy: posters route direct from gateway, not through
        // /api/img. See lib/media/shareImage.ts for the rationale.
        skipProxy
        className={`absolute inset-0 ${className ?? ''}`.trim()}
        onAllError={() => setPosterFailed(true)}
        priority={priority}
      />
    </>
  )

  if (videoFailed) {
    if (!poster || posterFailed) return null
    if (showPosterLayer) return posterLayer(poster)
    const posterFallback = isProxiable(poster) ? proxyUrl(poster) : poster
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={posterFallback} alt="" className={className} />
  }

  const showImageLayer = showPosterLayer && !!poster && !posterFailed
  const showThumbhashLayer = showPosterLayer && !showImageLayer && !!blurDataURL

  return (
    <>
      {showImageLayer && posterLayer(poster!)}
      {showThumbhashLayer && blurDataURL && (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center pointer-events-none"
          style={{ backgroundImage: `url(${blurDataURL})` }}
        />
      )}
      <SharedVideoSlot
        src={src}
        controls={!!controls}
        zIndex={zIndex}
        onError={() => setVideoFailed(true)}
        className={className}
      />
    </>
  )
}
