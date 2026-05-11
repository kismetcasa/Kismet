import { rgbaToThumbHash, thumbHashToDataURL } from 'thumbhash'

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
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    return thumbHashToDataURL(bytes)
  } catch {
    return undefined
  }
}
