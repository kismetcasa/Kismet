'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useFallbackUrl, isProxiable, proxyUrl } from '@/lib/media/gateway'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'

type VideoAttrs = Omit<
  React.VideoHTMLAttributes<HTMLVideoElement>,
  'src' | 'poster' | 'onError'
>

interface MomentVideoProps extends VideoAttrs {
  /** Raw URI for the video media: ar://, ipfs://, or https://. */
  src: string
  /** Optional poster URI. ar://ipfs:// routes through /api/img so it shares
   *  the edge cache with MomentImage; https/data: passes through unchanged. */
  poster?: string
  /** Base64 thumbhash from moment metadata. Decoded inline and painted as
   *  an absolute-positioned background behind the video until the first
   *  frame lands — same pattern as MomentImage's blurDataURL. */
  thumbhash?: string
  /** Fired once every gateway has errored, so the parent can swap in a placeholder. */
  onAllError?: () => void
}

/**
 * <video> equivalent of MomentImage. Walks the gateway pool on `src` error
 * (same `useFallbackUrl` walker), routes the poster through `/api/img` when
 * proxiable, and ships sensible autoplay defaults. The body itself goes
 * direct to the gateway — large videos can exceed `/api/img`'s 60s function
 * cap, so direct-streaming is the safer default.
 *
 * Layout: callers must give the wrapping element `position: relative` for
 * the thumbhash placeholder to lay behind the <video>. Matches MomentImage's
 * convention — every Moment* media surface already does this.
 */
export function MomentVideo({ src, poster, thumbhash, onAllError, ...rest }: MomentVideoProps) {
  const { url, onError } = useFallbackUrl(src, onAllError)
  const posterUrl = poster && isProxiable(poster) ? proxyUrl(poster) : poster
  const blurDataURL = useMemo(() => thumbhashToBlurDataURL(thumbhash), [thumbhash])
  const videoRef = useRef<HTMLVideoElement>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { setLoaded(false) }, [url])

  // Pause off-screen videos so a feed with many moving moments doesn't keep
  // every <video> decoding in the background. Skipped when the caller opted
  // into native controls — there, the user owns play/pause and the observer
  // would fight their input.
  useEffect(() => {
    const el = videoRef.current
    if (!el || rest.controls) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) el.play().catch(() => {})
        else el.pause()
      },
      { threshold: 0.01 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [url, rest.controls])

  // All gateways exhausted. Fall back to the poster (which routes through
  // /api/img and so has its own multi-gateway fan-out) instead of returning
  // null — silently disappearing media is worse than a still frame.
  if (!url) {
    if (!posterUrl) return null
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={posterUrl} alt="" className={rest.className} />
  }

  return (
    <>
      {!loaded && blurDataURL && (
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
        src={url}
        poster={posterUrl}
        onError={onError}
        onLoadedData={(e) => {
          setLoaded(true)
          rest.onLoadedData?.(e)
        }}
      />
    </>
  )
}
