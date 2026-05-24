import { isVideoMoment } from './isVideo'

export type MomentMediaKind = 'video' | 'gif' | 'image' | 'text' | 'none'

interface MediaMeta {
  image?: string
  animation_url?: string
  content?: { mime?: string; uri?: string }
}

export interface ResolvedMedia {
  kind: MomentMediaKind
  /** Primary URL to render: the video src, the (animated) gif src, or the
   *  still-image src. Undefined for `text` / `none`. */
  src?: string
  /** Static poster for the `video`/`gif` kinds when a non-animated image
   *  is also present. Never itself a gif. */
  poster?: string
}

// ar:// content is hash-addressed (no extension), so the extension test
// only catches `https://…/foo.gif`. The `image/gif` mime hint is the
// reliable signal for Kismet mints and most marketplaces.
function isGifUrl(url?: string): boolean {
  return !!url && url.split(/[?#]/, 1)[0]!.toLowerCase().endsWith('.gif')
}

/**
 * Single source of truth for "what does this moment render, and how".
 * Replaces the per-surface `isVideoMoment(meta) ? … : meta.image ? … : …`
 * chains that silently produced "no preview" for any GIF whose animated
 * bytes live in `animation_url` rather than `image`.
 *
 * Precedence: video → gif → text → still image. A GIF is surfaced whether
 * its bytes sit in `animation_url`, `image`, or are flagged only by the
 * `image/gif` mime — and we keep a static `image` as the poster when the
 * gif itself came from `animation_url`.
 */
export function resolveMomentMedia(meta: MediaMeta): ResolvedMedia {
  if (isVideoMoment(meta)) {
    return { kind: 'video', src: meta.animation_url, poster: meta.image }
  }

  const animIsGif = isGifUrl(meta.animation_url)
  const imageIsGif = isGifUrl(meta.image)
  const mimeIsGif = meta.content?.mime === 'image/gif'
  if (animIsGif || imageIsGif || mimeIsGif) {
    // Prefer the field that actually carries the gif. When the gif is the
    // animation_url and `image` is a static still, keep the still as poster.
    const src = animIsGif
      ? meta.animation_url
      : imageIsGif
        ? meta.image
        : (meta.animation_url ?? meta.image)
    if (src) {
      const poster = !imageIsGif ? meta.image : undefined
      return { kind: 'gif', src, poster }
    }
  }

  if (meta.content?.mime === 'text/plain') return { kind: 'text' }
  if (meta.image) return { kind: 'image', src: meta.image }
  return { kind: 'none' }
}
