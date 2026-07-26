'use client'

import { useEffect, useMemo, useState } from 'react'
import { isProxiable, proxyUrl } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { MomentImg } from './MomentImage'
import { InlineVideo } from './InlineVideo'

interface MomentVideoProps {
  /** Raw URI for the video media: ar://, ipfs://, or https://. */
  src: string
  /** Optional poster URI. When `showPosterLayer` is on, this renders as an
   *  <img> cover OVER the video that fades out once the first frame is ready
   *  (thumbhash → /api/img poster → video first frame), so the surface paints
   *  content the instant it mounts and never flashes the pre-decode black. */
  poster?: string
  /** Base64 thumbhash — drives the blur placeholder on the poster layer. */
  thumbhash?: string
  /** Render the poster as a static <img> cover layered OVER the video that
   *  fades out on the first frame. On for card/detail surfaces (the video is
   *  absolutely positioned under it); off when the video sizes itself in-flow
   *  via the passed className. */
  showPosterLayer?: boolean
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
  /** SSR proxy hint forwarded to InlineVideo — the detail page passes its
   *  server-computed isWebKitOnlyUA() so the SSR-rendered <video src> is
   *  proxy-first (not direct) for server-detectable constrained surfaces.
   *  Feed cards mount client-side and leave this false. */
  ssrProxyHint?: boolean
}

/**
 * Per-surface "view" of a video moment. Composes:
 *   - InlineVideo — a normal in-flow <video> the browser lays out, painted
 *     UNDER the poster and visible from mount (never opacity:0 — see below)
 *   - Poster image + thumbhash cover (MomentImg, instant on paint) layered
 *     OVER the video, fading out once the first frame is ready
 *
 * The cover-over-video order (not the old video-over-poster) is deliberate: an
 * iOS WebKit <video> composited while hidden (opacity:0) plays audio but paints
 * a black frame forever, so the video stays visible and the poster fades off it
 * instead. The video lives in the card's own DOM (no position:fixed pool), so
 * it can never park over the wrong card or smear on momentum scroll. currentTime
 * is carried across surfaces by src (InlineVideo's session memory) so the detail
 * resumes where the card left off; the poster covers the brief re-decode.
 */
export function MomentVideo({
  src,
  poster,
  thumbhash,
  showPosterLayer,
  controls,
  className,
  onAllError,
  priority,
  ssrProxyHint,
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

  // The <video> renders at opacity:1 from mount and never self-hides (an iOS
  // WebKit <video> composited while opacity:0 plays audio but paints a black
  // frame forever — the "I hear it but the screen is black" Mini App bug). So
  // the poster/thumbhash/skeleton is layered OVER the video and fades OUT once
  // InlineVideo reports a presentable first frame. `videoReady` drives that
  // cover; reset on src change so a new source re-covers until its own first
  // frame (and it fades back in when a feed video releases → loaded:false).
  const [videoReady, setVideoReady] = useState(false)
  useEffect(() => { setVideoReady(false) }, [src])

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
  // Neither a poster nor a thumbhash (older mints predating the thumbhash
  // write): without this the slot would sit on the parent's flat surface
  // colour until the video's first frame decodes. Paint the same branded
  // pulse MomentImage uses so a video card never shows an empty tile during
  // the render-in window; the cover fades out once a frame is ready.
  const showSkeleton = showPosterLayer && !showImageLayer && !showThumbhashLayer

  return (
    <>
      <InlineVideo
        src={src}
        controls={!!controls}
        ssrProxyHint={ssrProxyHint}
        onError={() => setVideoFailed(true)}
        onReadyChange={setVideoReady}
        // With a poster cover the video fills the slot underneath it
        // (absolute inset-0); otherwise it sizes itself in-flow.
        className={
          showPosterLayer ? `absolute inset-0 ${className ?? ''}`.trim() : className
        }
      />
      {showPosterLayer && (
        // Cover layer OVER the video (poster → thumbhash → skeleton), faded out
        // once the video reports a first frame. pointer-events-none so the
        // detail view's native <video> controls underneath stay tappable
        // through the fade, and so a zoomable parent's click still registers.
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{ opacity: videoReady ? 0 : 1, transition: 'opacity 0.2s ease' }}
        >
          {showImageLayer && posterLayer(poster!)}
          {showThumbhashLayer && blurDataURL && (
            <span
              aria-hidden
              className="absolute inset-0 bg-cover bg-center pointer-events-none"
              style={{ backgroundImage: `url(${blurDataURL})` }}
            />
          )}
          {showSkeleton && (
            <span
              aria-hidden
              className="absolute inset-0 bg-accent/10 animate-pulse pointer-events-none"
            />
          )}
        </div>
      )}
    </>
  )
}
