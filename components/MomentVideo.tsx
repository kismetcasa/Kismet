'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFallbackUrl, isProxiable, proxyUrl } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { MomentImage } from './MomentImage'

type VideoAttrs = Omit<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  'src' | 'poster' | 'onError'
>

interface MomentVideoProps extends VideoAttrs {
  /** Raw URI for the video media: ar://, ipfs://, or https://. */
  src: string
  /** Optional poster URI. When `showPosterLayer` is on, this renders as a
   *  full <MomentImage> behind the video so the slot has something to
   *  show the instant the page paints (thumbhash → AVIF/WebP poster →
   *  video first frame) instead of waiting for video bytes to stream from
   *  the gateway. */
  poster?: string
  /** Base64 thumbhash — drives the blur placeholder on the poster layer. */
  thumbhash?: string
  /** Render the poster as a MomentImage layer behind the video. Requires
   *  the parent to be `position: relative` with explicit dimensions (the
   *  next/image `fill` contract). On for card/modal/detail; off for the
   *  lightbox where the video sizes itself via max-w/max-h. */
  showPosterLayer?: boolean
  /** Sizes hint forwarded to the MomentImage poster layer. */
  posterSizes?: string
  /** Forwarded to next/image priority on the poster layer (above-the-fold). */
  priority?: boolean
  /** Fired once every gateway has errored, so the parent can swap in a placeholder. */
  onAllError?: () => void
}

/**
 * <video> equivalent of MomentImage. Three behaviours that together make
 * video moments feel instant:
 *
 *   1. The poster renders as a full MomentImage behind the video (when
 *      `showPosterLayer` is on) — uses next/image's AVIF/WebP transcode
 *      and 31-day edge cache, with an inline thumbhash blur for the very
 *      first paint. Without this, the slot stays blank for the 1-10s it
 *      can take to stream the first video frame from a cold Arweave
 *      gateway.
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
  posterSizes,
  priority,
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

  // All gateways exhausted. With showPosterLayer the MomentImage layer is
  // already mounted — re-render it on its own so the slot still shows the
  // poster. For the lightbox surface use a plain <img> sized by the
  // caller's className.
  if (!url) {
    if (!poster) return null
    if (showPosterLayer) {
      return (
        <MomentImage
          src={poster}
          alt=""
          fill
          preferProxy
          className={rest.className}
          sizes={posterSizes}
          thumbhash={thumbhash}
          priority={priority}
        />
      )
    }
    const posterFallback = isProxiable(poster) ? proxyUrl(poster) : poster
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={posterFallback} alt="" className={rest.className} />
  }

  // Native `poster` attr is redundant when the image layer paints the
  // pre-load state — skipping it avoids a duplicate poster fetch. For
  // surfaces without the image layer (lightbox) keep the native poster so
  // the slot isn't blank between metadata-load and first-frame.
  const nativePoster = showPosterLayer
    ? undefined
    : poster && isProxiable(poster) ? proxyUrl(poster) : poster

  // Decide what to render behind the video. Priority: MomentImage poster
  // layer (when both opt-in and a poster URI are available) > thumbhash
  // blur (when we have one) > nothing. Thumbhash is also gated on
  // showPosterLayer — its `absolute inset-0` positioning needs a properly
  // bounded `relative` parent, which the lightbox doesn't provide (the
  // video sizes itself via max-w/max-h there, so the blur would stretch
  // across the whole overlay).
  const showImageLayer = showPosterLayer && !!poster
  const showThumbhashLayer = showPosterLayer && !showImageLayer && !loaded && !!blurDataURL

  // Only hide the video while a placeholder is actually rendered behind
  // it. If there's nothing to fall back to (no poster, no thumbhash),
  // the video stays visible from the start so the slot doesn't go dark.
  // No transition — the snap from poster to first frame is invisible
  // because they're the same image, and any fade compounds with gateway
  // walks into a perceived flicker.
  const hideUntilLoaded = (showImageLayer || showThumbhashLayer) && !loaded
    ? ' opacity-0'
    : ''

  return (
    <>
      {showImageLayer && (
        <MomentImage
          src={poster!}
          alt=""
          fill
          // Skip next/image's optimizer and go straight to /api/img — the
          // optimizer's single-source arweave.net fetch is the bottleneck
          // on cold cache. /api/img races every gateway and edge-caches
          // the bytes. Trade-off (no AVIF) is acceptable for a poster
          // that's covered by the video as soon as the first frame lands.
          preferProxy
          className={rest.className}
          sizes={posterSizes}
          thumbhash={thumbhash}
          priority={priority}
        />
      )}
      {showThumbhashLayer && (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center pointer-events-none"
          style={{ backgroundImage: `url(${blurDataURL})` }}
        />
      )}
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
