import type { FFmpeg } from '@ffmpeg/ffmpeg'

// ~100MB cap on source size — past this, ffmpeg.wasm's memory pressure on
// phones makes the transcode unreliable. Bigger GIFs fall back to direct
// upload; the proxy + edge cache from earlier phases still helps.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024

let ffmpegPromise: Promise<FFmpeg> | null = null

async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      // Dynamic import keeps the ~110KB ffmpeg JS wrapper out of the main
      // bundle. The 31MB wasm is fetched on demand from /ffmpeg-core/.
      const { FFmpeg } = await import('@ffmpeg/ffmpeg')
      const { toBlobURL } = await import('@ffmpeg/util')
      const ff = new FFmpeg()
      // toBlobURL fetches the core files and wraps them in blob: URLs so
      // the ffmpeg worker can load them without cross-origin worker issues.
      // Self-hosted under /ffmpeg-core/ (postinstall copies them out of
      // node_modules/@ffmpeg/core/dist/umd/).
      const base = '/ffmpeg-core'
      await ff.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      })
      return ff
    })()
  }
  return ffmpegPromise
}

export function isAnimatedGifLike(file: File): boolean {
  return file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')
}

export function canTranscode(file: File): boolean {
  return isAnimatedGifLike(file) && file.size <= MAX_SOURCE_BYTES
}

/**
 * Extract the first frame of a GIF as a JPEG. Used for collection covers,
 * which only render statically — no need to pay the H.264 encode for an
 * animation that's never played.
 */
export async function extractGifPoster(file: File): Promise<File> {
  const ff = await getFFmpeg()
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await ff.writeFile('in.gif', bytes)
    await ff.exec([
      '-i', 'in.gif',
      '-vf', 'select=eq(n\\,0)',
      '-vframes', '1',
      '-q:v', '5',
      'poster.jpg',
    ])
    const posterBytes = (await ff.readFile('poster.jpg')) as Uint8Array
    if (posterBytes.byteLength === 0) throw new Error('ffmpeg produced empty poster')
    const base = file.name.replace(/\.gif$/i, '') || 'cover'
    return new File([posterBytes as BlobPart], `${base}.jpg`, { type: 'image/jpeg' })
  } finally {
    for (const f of ['in.gif', 'poster.jpg']) {
      try { await ff.deleteFile(f) } catch {}
    }
  }
}

/**
 * Transcode a GIF to MP4 + extract its first frame as a JPEG poster.
 *
 * The MP4 uses H.264 baseline + yuv420p (universal browser playback),
 * `faststart` (the moov atom moves to the front of the file so the
 * `<video>` element starts playing before the full body downloads), and
 * even dimensions (H.264 requirement). No audio — GIFs don't have any.
 *
 * Throws on any ffmpeg failure; caller falls back to uploading the
 * original GIF unchanged.
 */
export async function transcodeGifToMp4(
  file: File,
  onProgress: (pct: number) => void = () => {},
): Promise<{ mp4: File; poster: File }> {
  const ff = await getFFmpeg()
  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))))
  }
  ff.on('progress', progressHandler)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await ff.writeFile('in.gif', bytes)
    await ff.exec([
      '-i', 'in.gif',
      '-vf', 'select=eq(n\\,0)',
      '-vframes', '1',
      '-q:v', '5',
      'poster.jpg',
    ])
    await ff.exec([
      '-i', 'in.gif',
      '-movflags', 'faststart',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-an',
      'out.mp4',
    ])
    const mp4Bytes = (await ff.readFile('out.mp4')) as Uint8Array
    const posterBytes = (await ff.readFile('poster.jpg')) as Uint8Array
    if (mp4Bytes.byteLength === 0 || posterBytes.byteLength === 0) {
      throw new Error('ffmpeg produced empty output')
    }
    const base = file.name.replace(/\.gif$/i, '') || 'media'
    return {
      mp4: new File([mp4Bytes as BlobPart], `${base}.mp4`, { type: 'video/mp4' }),
      poster: new File([posterBytes as BlobPart], `${base}.jpg`, { type: 'image/jpeg' }),
    }
  } finally {
    ff.off('progress', progressHandler)
    // Best-effort cleanup; ignore if the files weren't created (early throw).
    for (const f of ['in.gif', 'out.mp4', 'poster.jpg']) {
      try { await ff.deleteFile(f) } catch {}
    }
  }
}
