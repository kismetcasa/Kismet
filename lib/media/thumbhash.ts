import { rgbaToThumbHash, thumbHashToDataURL, thumbHashToApproximateAspectRatio, thumbHashToAverageRGBA } from 'thumbhash'
import { LRUCache } from '@/lib/lruCache'

// Decoded blur data-URLs keyed by the source base64 thumbhash. The decode is
// a synchronous pure-JS PNG encode (~0.5-2ms each) that the feed otherwise
// re-runs on every card mount — and because LazyMount unmounts cards at
// 3000px and remounts them on scroll-back, the same hash is decoded again and
// again during a scroll, and once more per tab a moment appears in. A card's
// own useMemo only survives until it unmounts; this process-level cache
// survives remounts and is shared across every card/tab/feed, so each unique
// hash is decoded at most once. Bounded so a long session can't leak. `undefined`
// results (malformed input) are cached too so bad hashes aren't retried.
const blurUrlCache = new LRUCache<string, string | undefined>(512)

// Downscale target before encoding. Past 100px the encode is slower
// without meaningful placeholder-quality gain.
const MAX_DIM = 100

async function extractFirstFrameBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap on a GIF Blob decodes frame 0 natively.
  if (file.type.startsWith('image/')) return createImageBitmap(file)
  if (file.type.startsWith('video/')) {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = URL.createObjectURL(file)
    try {
      await new Promise<void>((resolve, reject) => {
        v.addEventListener('loadeddata', () => resolve(), { once: true })
        v.addEventListener('error', () => reject(new Error('video decode failed')), { once: true })
      })
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight)
      c.getContext('2d')!.drawImage(v, 0, 0)
      return createImageBitmap(c)
    } finally {
      URL.revokeObjectURL(v.src)
    }
  }
  throw new Error(`unsupported file type for thumbhash: ${file.type}`)
}

/**
 * Generate a thumbhash for `file` — a ~25-byte placeholder bound to the
 * moment's metadata. Returns a base64 string suitable for storing in JSON,
 * or null on any failure (caller falls back to the skeleton placeholder).
 */
export async function generateThumbhash(file: File): Promise<string | null> {
  try {
    const bitmap = await extractFirstFrameBitmap(file)
    const scale = Math.min(MAX_DIM / bitmap.width, MAX_DIM / bitmap.height, 1)
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    const hash = rgbaToThumbHash(w, h, data)
    // btoa over a Uint8Array via String.fromCharCode is safe up to ~32 bytes,
    // and thumbhash output is bounded at ~25 bytes regardless of input size.
    return btoa(String.fromCharCode(...hash))
  } catch {
    return null
  }
}

/**
 * Decode a base64 thumbhash to a data URL for next/image's blurDataURL.
 * Returns undefined on malformed/missing input — caller falls back to skeleton.
 */
export function thumbhashToBlurDataURL(b64: string | undefined): string | undefined {
  if (!b64) return undefined
  if (blurUrlCache.has(b64)) return blurUrlCache.get(b64)
  let result: string | undefined
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    result = thumbHashToDataURL(bytes)
  } catch {
    result = undefined
  }
  blurUrlCache.set(b64, result)
  return result
}

// Approximate width/height aspect ratio (encoded in every thumbhash). Lets a
// surface size its frame to the artwork's shape BEFORE the full image loads —
// so the box can hug the image with no letterbox and no layout shift. Returns
// undefined on malformed/missing input; the caller refines to the exact ratio
// once the real image reports its natural dimensions.
export function thumbhashToRatio(b64: string | undefined): number | undefined {
  if (!b64) return undefined
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return thumbHashToApproximateAspectRatio(bytes)
  } catch {
    return undefined
  }
}

// Average RGB (0-255) encoded in a base64 thumbhash — a zero-fetch color seed
// used as the profile-theme palette-extraction fallback. null on malformed or
// missing input. Client-safe (atob, no Node Buffer).
export function thumbhashAverageRgb(b64: string | undefined): [number, number, number] | null {
  if (!b64) return null
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const { r, g, b } = thumbHashToAverageRGBA(bytes)
    return [r * 255, g * 255, b * 255]
  } catch {
    return null
  }
}
