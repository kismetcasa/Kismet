'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Film } from 'lucide-react'
import { useFallbackUrl, isProxiable, proxyUrl } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { MomentImg } from './MomentImage'

type VideoAttrs = Omit<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  'src' | 'poster' | 'onError'
>

interface MomentVideoProps extends VideoAttrs {
  /** Raw URI for the video media: ar://, ipfs://, or https://. */
  src: string
  /** Optional poster URI. When `showPosterLayer` is on, this renders as an
   *  <img> behind the video so the slot has something to show the instant
   *  the page paints (thumbhash → /api/img poster → video first frame). */
  poster?: string
  /** Base64 thumbhash — drives the blur placeholder on the poster layer. */
  thumbhash?: string
  /** Render the poster as a static <img> layer behind the video. Requires
   *  the parent to be `position: relative` with explicit dimensions. On for
   *  card/modal/detail; off for the lightbox where the video sizes itself
   *  via max-w/max-h. */
  showPosterLayer?: boolean
  /** Fired once every gateway has errored, so the parent can swap in a placeholder. */
  onAllError?: () => void
}

/**
 * <video> equivalent of MomentImage. Three behaviours that together make
 * video moments feel instant:
 *
 *   1. The poster renders as a static <img> behind the video (when
 *      `showPosterLayer` is on), with an inline thumbhash blur for the
 *      very first paint. Without this, the slot stays blank for the 1-10s
 *      it can take to stream the first video frame from a cold Arweave
 *      gateway. We use MomentImg (not MomentImage) here because
 *      MomentImage's `animate-pulse` skeleton — which fires when no
 *      thumbhash is stored — reads as a blink for moments minted before
 *      the thumbhash backfill existed. MomentImg keeps the same /api/img
 *      proxy + gateway-walk semantics without the skeleton.
 *
 *   2. The video bytes lazy-load via IntersectionObserver. Only feed-card
 *      surfaces benefit (lightbox/modal/detail opt into eager loading via
 *      `controls` or `preload="auto"`) — it stops 30 off-screen videos
 *      from racing the visible ones for bandwidth.
 *
 *   3. The gateway walker (`useFallbackUrl`) and the all-gateways-failed
 *      fallback to the poster image still apply, matching MomentImage's
 *      onAllError contract.
 */
export function MomentVideo({
  src,
  poster,
  thumbhash,
  showPosterLayer,
  onAllError,
  ...rest
}: MomentVideoProps) {
  const { url, onError } = useFallbackUrl(src, onAllError)
  const blurDataURL = useMemo(() => thumbhashToBlurDataURL(thumbhash), [thumbhash])
  const videoRef = useRef<HTMLVideoElement>(null)
  const [loaded, setLoaded] = useState(false)
  // Eager surfaces (controls or preload=auto) start fetching immediately;
  // others defer the bytes-fetch until the element approaches the viewport.
  const eager = !!rest.controls || rest.preload === 'auto'
  const [shouldLoad, setShouldLoad] = useState(eager)
  useEffect(() => { setLoaded(false) }, [url])

  // Pause off-screen videos AND defer their initial load. Skipped on
  // controls — the user owns play/pause there and the observer would
  // fight their input. rootMargin gives the bytes a head start so the
  // first frame is usually ready by the time the card is fully visible.
  useEffect(() => {
    const el = videoRef.current
    if (!el || rest.controls) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true)
          el.play().catch(() => {})
        } else {
          el.pause()
        }
      },
      { threshold: 0.01, rootMargin: '200px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [url, rest.controls])

  // Poster layer used both as the placeholder behind the video AND as the
  // fallback when every video gateway has errored. MomentImg routes ar:/
  // ipfs: through /api/img and walks the gateway pool on proxy error.
  // Thumbhash (when present) paints behind it as an instant placeholder.
  const renderPosterLayer = () => (
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
        className={`absolute inset-0 ${rest.className ?? ''}`.trim()}
      />
    </>
  )

  // Quiet "video here" placeholder for moments minted before the poster
  // and thumbhash backfills existed — we have nothing to paint until the
  // video bytes arrive, so the slot would otherwise look like a black
  // empty card. Matches the styling of the text-moment placeholder in
  // MomentCard so video-no-preview reads as a sibling state.
  const renderIconPlaceholder = () => (
    <div
      aria-hidden
      className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-[#1a1a1a] to-[#0a0a0a] pointer-events-none"
    >
      <Film className="text-[#333]" size={32} strokeWidth={1.5} />
    </div>
  )

  // All video gateways exhausted. Show the poster if we have one; for
  // showPosterLayer surfaces with neither poster nor video, fall back to
  // the icon so the slot stays visually populated instead of returning
  // null (which leaves a black hole in the grid).
  if (!url) {
    if (poster) {
      if (showPosterLayer) return renderPosterLayer()
      const posterFallback = isProxiable(poster) ? proxyUrl(poster) : poster
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={posterFallback} alt="" className={rest.className} />
    }
    return showPosterLayer ? renderIconPlaceholder() : null
  }

  // Native `poster` attr is redundant when the image layer paints the
  // pre-load state — skipping it avoids a duplicate poster fetch. For
  // surfaces without the image layer (lightbox) keep the native poster so
  // the slot isn't blank between metadata-load and first-frame.
  const nativePoster = showPosterLayer
    ? undefined
    : poster && isProxiable(poster) ? proxyUrl(poster) : poster

  // Decide what to render behind the video. Priority: poster image (when
  // both opt-in and a poster URI are available) > thumbhash blur (when we
  // have one) > icon placeholder. All gated on showPosterLayer — their
  // absolute inset-0 positioning needs a bounded relative parent, which
  // the lightbox doesn't provide.
  const showImageLayer = showPosterLayer && !!poster
  const showThumbhashLayer = showPosterLayer && !showImageLayer && !loaded && !!blurDataURL
  const showIconPlaceholder = showPosterLayer && !showImageLayer && !showThumbhashLayer && !loaded

  // While there's a placeholder behind it, keep the video at opacity-0
  // so the placeholder shows through. Once loaded, the video paints over
  // whichever placeholder we chose.
  const hideUntilLoaded = (showImageLayer || showThumbhashLayer || showIconPlaceholder) && !loaded
    ? ' opacity-0'
    : ''

  return (
    <>
      {showImageLayer && renderPosterLayer()}
      {showThumbhashLayer && (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center pointer-events-none"
          style={{ backgroundImage: `url(${blurDataURL})` }}
        />
      )}
      {showIconPlaceholder && renderIconPlaceholder()}
      <video
        ref={videoRef}
        key={url}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        {...rest}
        className={`${rest.className ?? ''}${hideUntilLoaded}`.trim()}
        poster={nativePoster}
        src={shouldLoad ? url : undefined}
        onError={onError}
        onLoadedData={(e) => {
          setLoaded(true)
          rest.onLoadedData?.(e)
        }}
      />
    </>
  )
}
