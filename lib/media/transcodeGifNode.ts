import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'

const execFileAsync = promisify(execFile)

// Kill a runaway encode rather than letting it pin a CPU on the shared
// (resource-constrained) server indefinitely. Generous enough for a large
// GIF on a slow host; the caller treats a timeout as a normal failure.
const FFMPEG_TIMEOUT_MS = 180_000

/**
 * Server-side GIF → MP4 + poster, the no-wasm-cap counterpart to
 * lib/media/transcodeGif.ts (which runs in the browser and tops out at
 * 100MB). Identical ffmpeg recipe (H.264 yuv420p + faststart, even dims,
 * -g 30 for cheap seeks) so a server-transcoded clip is byte-compatible
 * with the client-transcoded ones. Requires `ffmpeg` on PATH (installed in
 * the Docker runtime image).
 *
 * Returns the encoded bytes plus a thumbhash computed from the poster, so
 * the caller gets the same placeholder the client path produces.
 */
export async function transcodeGifToMp4Node(
  gif: Buffer,
): Promise<{ mp4: Buffer; poster: Buffer; thumbhash: string | null }> {
  const dir = await mkdtemp(join(tmpdir(), 'gifmp4-'))
  const inPath = join(dir, 'in.gif')
  const mp4Path = join(dir, 'out.mp4')
  const posterPath = join(dir, 'poster.jpg')
  try {
    await writeFile(inPath, gif)
    // Poster = frame 0. The comma in the select filter is escaped for
    // ffmpeg's filtergraph parser (matches the wasm recipe).
    await execFileAsync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', inPath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', '-q:v', '5', posterPath],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL' },
    )
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error', '-i', inPath,
        '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-g', '30', '-an',
        mp4Path,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 * 64 },
    )
    const [mp4, poster] = await Promise.all([readFile(mp4Path), readFile(posterPath)])
    if (mp4.byteLength === 0 || poster.byteLength === 0) {
      throw new Error('ffmpeg produced empty output')
    }
    return { mp4, poster, thumbhash: await posterThumbhash(poster) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Thumbhash from the poster JPEG — the server-side equivalent of the
 * canvas-based generateThumbhash() the browser uses. Bounded to 100px so
 * the encode stays cheap and within thumbhash's input limits. Returns null
 * on any failure; the placeholder is a nicety, never load-bearing.
 */
async function posterThumbhash(poster: Buffer): Promise<string | null> {
  try {
    const { data, info } = await sharp(poster)
      .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const hash = rgbaToThumbHash(info.width, info.height, new Uint8Array(data))
    return Buffer.from(hash).toString('base64')
  } catch {
    return null
  }
}
