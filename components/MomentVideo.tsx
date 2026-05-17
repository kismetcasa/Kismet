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
  /** Vestigial — pool ignores caller-passed `preload`. The pool sets
   *  preload='auto' on controlled slots, 'metadata' on previews. Kept
   *  in the prop signature for backward-compatibility with call sites
   *  that previously passed it; safe to omit at the callsite. */
  preload?: 'none' | 'metadata' | 'auto'
  /** Fired once every gateway has errored for the video (separate from
   *  poster errors). Parent can swap in a placeholder. */
  onAllError?: () => void
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
}: MomentVideoProps) {
  const blurDataURL = useMemo(() => thumbhashToBlurDataURL(thumbhash), [thumbhash])

  // Per-surface poster degradation. If MomentImg walks all gateways
  // without successfully rendering the URL as an image (e.g. legacy
  // bug where meta.image was set to the video URL itself), drop the
  // image layer and fall through to thumbhash / bare slot.
  const [posterFailed, setPosterFailed] = useState(false)
  useEffect(() => { setPosterFailed(false) }, [poster])

  // Per-surface video failure. The pool walks gateways internally; when
  // all are exhausted it fires onError on the active slot. We unmount
  // the slot and show poster-only.
  const [videoFailed, setVideoFailed] = useState(false)
  useEffect(() => { setVideoFailed(false) }, [src])

  // Surface the catastrophic "no video AND no poster" case to the
  // parent via onAllError. Done in an effect, not inside render, to
  // avoid the React anti-pattern of side effects during render
  // (matters under concurrent rendering / Strict Mode).
  useEffect(() => {
    if (videoFailed && (!poster || posterFailed)) onAllError?.()
  }, [videoFailed, posterFailed, poster, onAllError])

  // All-gateways-exhausted fallback for video + poster: render the
  // poster directly so the surface isn't blank.
  if (videoFailed) {
    if (!poster || posterFailed) {
      return null
    }
    if (showPosterLayer) {
      return (
        <>
          {blurDataURL && (
            <span
              aria-hidden
              className="absolute inset-0 bg-cover bg-center pointer-events-none"
              style={{ backgroundImage: `url(${blurDataURL})` }}
            />
          )}
          <MomentImg
            src={poster}
            alt=""
            skipProxy
            className={`absolute inset-0 ${className ?? ''}`.trim()}
            onAllError={() => setPosterFailed(true)}
          />
        </>
      )
    }
    const posterFallback = isProxiable(poster) ? proxyUrl(poster) : poster
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={posterFallback} alt="" className={className} />
  }

  const showImageLayer = showPosterLayer && !!poster && !posterFailed
  const showThumbhashLayer = showPosterLayer && !showImageLayer && !!blurDataURL

  return (
    <>
      {showImageLayer && (
        <>
          {blurDataURL && (
            <span
              aria-hidden
              className="absolute inset-0 bg-cover bg-center pointer-events-none"
              style={{ backgroundImage: `url(${blurDataURL})` }}
            />
          )}
          <MomentImg
            src={poster!}
            alt=""
            // skipProxy: posters route direct from gateway, not through
            // /api/img. See lib/media/shareImage.ts for the rationale.
            skipProxy
            className={`absolute inset-0 ${className ?? ''}`.trim()}
            onAllError={() => setPosterFailed(true)}
          />
        </>
      )}
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
