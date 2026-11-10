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
// sharp jobs run at once, so one runs at a time. The same image asked for at
// once (each crawler of a fresh share) joins the decode already running. A
// different one waits its turn for up to the caller's `waitMs` (none by
// default): the image proxy waits out its compute budget, since its output is
// cached forever, and a share card only briefly, since a crawler gives up
// within seconds.
const MAX_CONCURRENT_DECODES = 1
const decodes = new SingleFlight<Buffer>()
let running = 0
const queued: Array<() => void> = []

function acquire(waitMs: number): Promise<boolean> {
  if (running < MAX_CONCURRENT_DECODES) {
    running++
    return Promise.resolve(true)
  }
  if (waitMs <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const turn = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      queued.splice(queued.indexOf(turn), 1)
      resolve(false)
    }, waitMs)
    queued.push(turn)
  })
}

function release(): void {
  const next = queued.shift()
  // Hand the slot straight to the next in line; `running` stays as it is.
  if (next) next()
  else running--
}

/**
 * Decode a JPEG XL image into a PNG no larger than `maxEdge` on either side,
 * with the `ffmpeg` on PATH (the runtime image's is built with libjxl).
 * sharp's prebuilt libvips has no JPEG XL decoder (sharp.format.jxl.input is
 * all false), so without this a .jxl image never becomes pixels server-side.
 * Rejects on any failure: no decoder, too many pixels, corrupt, too slow, or
 * busy with another image past `waitMs`.
 */
export function jpegXlToPng(bytes: Buffer, maxEdge: number, { waitMs = 0 } = {}): Promise<Buffer> {
  const key = `${createHash('sha256').update(bytes).digest('hex')}:${maxEdge}`
  return decodes.run(key, async () => {
    if (!(await acquire(waitMs))) throw new Error('jpeg xl decode busy')
    try {
      return await decode(bytes, maxEdge)
    } finally {
      release()
    }
  })
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
