import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SingleFlight } from '@/lib/media/imgVariantCache'

const execFileAsync = promisify(execFile)

// The two ways a JPEG XL file starts: a bare codestream, or the box container
// most exporters wrap one in (ISO/IEC 18181-2).
const CODESTREAM_SIGNATURE = Buffer.from([0xff, 0x0a])
const CONTAINER_SIGNATURE = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a])

export function isJpegXl(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, CODESTREAM_SIGNATURE.length).equals(CODESTREAM_SIGNATURE) ||
    bytes.subarray(0, CONTAINER_SIGNATURE.length).equals(CONTAINER_SIGNATURE)
  )
}

// A JPEG XL header can promise any size in a few bytes — 51 megapixels of one
// colour is 7KB, and decoding it took 788MB. ffmpeg checks -max_pixels against
// the header before it allocates a frame, so such a file is refused in
// milliseconds. 24MP fits a 6000×4000 camera frame. Decoding costs up to ~58
// bytes a pixel (measured at 24MP: 8-bit RGB 204MB, 16-bit RGBA 1.4GB), hence
// one decode at a time below.
const MAX_PIXELS = 24_000_000
// Kill a decode that outlives a crawler's patience rather than pin a CPU on
// the shared box; the caller treats it as a normal failure.
const FFMPEG_TIMEOUT_MS = 5_000
// Each decode is its own process, outside the libuv pool that bounds how many
// sharp jobs run at once. The same cover asked for at once (each crawler of a
// fresh share) joins the decode already running; a different one fails fast
// (the caller's fallback) rather than stack a second process on the box.
const MAX_CONCURRENT_DECODES = 1
const decodes = new SingleFlight<Buffer>()

/**
 * Decode a JPEG XL image into a PNG no larger than `maxEdge` on either side,
 * with the `ffmpeg` on PATH (the runtime image's is built with libjxl).
 * sharp's prebuilt libvips has no JPEG XL decoder (sharp.format.jxl.input is
 * all false), so without this a .jxl cover never becomes pixels server-side.
 * Rejects on any failure: no decoder, too many pixels, corrupt, too slow, or
 * busy with another image.
 */
export function jpegXlToPng(bytes: Buffer, maxEdge: number): Promise<Buffer> {
  const key = `${createHash('sha256').update(bytes).digest('hex')}:${maxEdge}`
  if (!decodes.has(key) && decodes.size >= MAX_CONCURRENT_DECODES) {
    return Promise.reject(new Error('jpeg xl decode busy'))
  }
  return decodes.run(key, () => decode(bytes, maxEdge))
}

async function decode(bytes: Buffer, maxEdge: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'jxl-'))
  const inPath = join(dir, 'in.jxl')
  const outPath = join(dir, 'out.png')
  try {
    await writeFile(inPath, bytes)
    await execFileAsync(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error', '-max_pixels', String(MAX_PIXELS),
        // Name the demuxer rather than let ffmpeg probe untrusted bytes.
        '-f', 'jpegxl_pipe', '-i', inPath, '-frames:v', '1',
        // Fit inside maxEdge, never enlarged. RGBA keeps any transparency for
        // the caller to flatten, as it would a PNG's.
        '-vf', `scale=min(${maxEdge}\\,iw):min(${maxEdge}\\,ih):force_original_aspect_ratio=decrease`,
        '-pix_fmt', 'rgba', outPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL' },
    )
    const png = await readFile(outPath)
    if (png.byteLength === 0) throw new Error('ffmpeg produced empty output')
    return png
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
