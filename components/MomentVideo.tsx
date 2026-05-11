'use client'

import { useFallbackUrl, isProxiable, proxyUrl } from '@/lib/media/gateway'

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
  /** Fired once every gateway has errored, so the parent can swap in a placeholder. */
  onAllError?: () => void
}

/**
 * <video> equivalent of MomentImage. Walks the gateway pool on `src` error
 * (same `useFallbackUrl` walker), routes the poster through `/api/img` when
 * proxiable, and ships sensible autoplay defaults. The body itself goes
 * direct to the gateway — large videos can exceed `/api/img`'s 60s function
 * cap, so direct-streaming is the safer default.
 */
export function MomentVideo({ src, poster, onAllError, ...rest }: MomentVideoProps) {
  const { url, onError } = useFallbackUrl(src, onAllError)
  if (!url) return null
  const posterUrl = poster && isProxiable(poster) ? proxyUrl(poster) : poster
  return (
    <video
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
    />
  )
}
