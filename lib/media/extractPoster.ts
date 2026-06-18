'use client'

import { reportClientError } from '@/lib/clientError'

/**
 * Extract the first frame of a video file as a JPEG File, suitable for
 * uploading to Arweave as a moment's `image` poster.
 *
 * Browser-native (HTMLVideoElement → canvas → JPEG blob), so it has no
 * FFmpeg.wasm dependency and works on long videos that would exceed the
 * GIF transcoder's ~100MB ceiling. Mirrors the technique used inside
 * `lib/media/thumbhash.ts` for the same reason.
 *
 * Returns null on any decode/encode failure; callers should fall back to
 * letting `meta.image` stay undefined rather than substituting the video
 * URL itself (which the renderer would try to load as an image and fail).
 */

// Bound the first-frame decode. A codec the browser can't decode (HEVC/H.265,
// 10-bit, ProRes) can leave the <video> element firing NEITHER `loadeddata`
// NOR `error`, so the await below would never settle and the entire mint
// would hang here with no error — the single unbounded operation in the
// large-video path. The timeout converts that silent hang into a clean skip:
// the poster stays null (best-effort; the mint proceeds without it) and we
// report WHY so a hung/undecodable file shows up as a real signal instead of
// a stall the user just gives up on.
const POSTER_TIMEOUT_MS = 12_000

export async function extractVideoPoster(file: File): Promise<File | null> {
  if (!file.type.startsWith('video/')) return null
  const objectUrl = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  video.src = objectUrl
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('poster extraction timed out')),
        POSTER_TIMEOUT_MS,
      )
      video.addEventListener('loadeddata', () => resolve(), { once: true })
      video.addEventListener('error', () => reject(new Error('video decode failed')), { once: true })
    })
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.85),
    )
    if (!blob) return null
    const base = file.name.replace(/\.[^.]+$/, '') || 'poster'
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg' })
  } catch (err) {
    // Report WHY the poster was skipped — a timeout (undecodable codec /
    // stalled decode), an explicit decode error, or an encode failure — with
    // the file shape, so even a posterless mint tells us exactly what happened.
    reportClientError('poster_extract_failed', {
      reason: err instanceof Error ? err.message : String(err),
      fileType: file.type,
      fileSize: file.size,
    })
    return null
  } finally {
    clearTimeout(timer)
    // Abort any in-flight decode so a timed-out 187MB load doesn't keep
    // churning in the background, then release the URL. removeAttribute + load()
    // is the footgun-free abort: `video.src = ''` resolves the empty string
    // against the document URL in some browsers and can trigger a spurious
    // page load; removing the attribute hits the spec's "no source" path, which
    // aborts cleanly with no error event.
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(objectUrl)
  }
}
