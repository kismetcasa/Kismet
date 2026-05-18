import type { FFmpeg } from '@ffmpeg/ffmpeg'

// Past ~100MB, ffmpeg.wasm starts OOM'ing on phones. Bigger GIFs upload
// unchanged — proxy + edge cache still help.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024

let ffmpegPromise: Promise<FFmpeg> | null = null

/** Lazy singleton — load + initialize ffmpeg.wasm once and share across
 *  every media operation in the upload flow (GIF transcode, video
 *  faststart remux, future variants). The instance is single-threaded;
 *  concurrent callers must serialise via the upload pipeline (MintForm
 *  already does this — only one branch runs per submission). */
export async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      // Dynamic-imported so the ~110KB JS + 31MB wasm only loads when a
      // user actually picks a GIF. Self-hosted under /ffmpeg-core/ (copied
      // out of @ffmpeg/core by scripts/copy-ffmpeg-core.mjs at install).
      const { FFmpeg } = await import('@ffmpeg/ffmpeg')
      const { toBlobURL } = await import('@ffmpeg/util')
      const ff = new FFmpeg()
      await ff.load({
        coreURL: await toBlobURL('/ffmpeg-core/ffmpeg-core.js', 'text/javascript'),
        wasmURL: await toBlobURL('/ffmpeg-core/ffmpeg-core.wasm', 'application/wasm'),
      })
      return ff
    })()
  }
  return ffmpegPromise
}

export function canTranscode(file: File): boolean {
  const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')
  return isGif && file.size <= MAX_SOURCE_BYTES
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
 * Transcode a GIF to MP4 (H.264 yuv420p, faststart, even dims for browser
 * compat) + extract frame 0 as a JPEG poster. Throws on any ffmpeg
 * failure; caller falls back to the original.
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
      // Keyframe at most every 30 frames (~1s at 30fps). Default libx264
      // GOP is 250, which on a short clip means a single keyframe at the
      // start — every seek decodes the whole file forward to the seek
      // target. With `-g 30` the detail page's currentTime restore (and
      // user scrubbing via native controls) lands on the nearest keyframe
      // within ~1s, cutting seek-decode time by ~3x. Costs ~10-20% file
      // size; negligible for Kismet's GIF-replacement clip lengths.
      '-g', '30',
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
