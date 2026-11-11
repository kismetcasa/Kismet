import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'

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
// the shared box; the caller treats it as a normal failure. A caller whose
// result outlasts the request passes a longer `timeoutMs`: the largest image
// allowed took 4.7s to decode on one core here.
const FFMPEG_TIMEOUT_MS = 5_000
// Each decode is its own process, outside the libuv pool that bounds how many
// sharp jobs run at once, so one runs at a time. Another waits its turn for
// up to the caller's `waitMs` (none by default): the image proxy waits out its
// compute budget, since its output is cached forever, and a share card only
// briefly, since a crawler gives up within seconds.
const MAX_CONCURRENT_DECODES = 1
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
export async function jpegXlToPng(
  bytes: Buffer,
  maxEdge: number,
  { waitMs = 0, timeoutMs = FFMPEG_TIMEOUT_MS } = {},
): Promise<Buffer> {
  if (!(await acquire(waitMs))) throw new Error('jpeg xl decode busy')
  try {
    return await withDisplayP3Profile(await decode(bytes, maxEdge, timeoutMs))
  } finally {
    release()
  }
}

async function decode(bytes: Buffer, maxEdge: number, timeoutMs: number): Promise<Buffer> {
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
      { timeout: timeoutMs, killSignal: 'SIGKILL' },
    )
    const png = await readFile(outPath)
    if (png.byteLength === 0) throw new Error('ffmpeg produced empty output')
    return png
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// A JPEG XL can name a standard colour space instead of carrying an ICC
// profile. ffmpeg writes such a name into the PNG as a cICP chunk, which sharp
// ignores, so a Display P3 image (the wide gamut Apple devices shoot in) would
// be read as sRGB and come out washed out. A Display P3 decode therefore gets
// that profile as an iCCP chunk, which sharp converts to sRGB from as it does
// for any tagged image. One that carries an ICC profile already comes out
// with it; any other named space passes as it came.
const CICP_DISPLAY_P3 = [12, 13] // primaries P3-D65 (SMPTE EG 432-1), sRGB transfer
let displayP3Profile: Promise<Buffer> | undefined

async function withDisplayP3Profile(png: Buffer): Promise<Buffer> {
  // The chunks after the 8-byte signature: length, type, data, CRC.
  let cicp: Buffer | undefined
  let at = 8
  for (; at + 8 <= png.length; at += 12 + png.readUInt32BE(at)) {
    const type = png.toString('latin1', at + 4, at + 8)
    if (type === 'iCCP') return png
    if (type === 'IDAT') break
    if (type === 'cICP') cicp = png.subarray(at + 8, at + 12)
  }
  if (cicp?.[0] !== CICP_DISPLAY_P3[0] || cicp[1] !== CICP_DISPLAY_P3[1] || at + 8 > png.length) return png
  displayP3Profile ??= sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
    .withIccProfile('p3')
    .png()
    .toBuffer()
    .then(async (b) => (await sharp(b).metadata()).icc ?? Promise.reject(new Error('no p3 profile')))
  // Without the profile, the colours shift but the image still converts.
  const profile = await displayP3Profile.catch(() => null)
  if (!profile) return png
  // Name, its null, compression method 0 (deflate), then the profile.
  const data = Buffer.concat([Buffer.from('Display P3\0\0', 'latin1'), deflateSync(profile)])
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write('iCCP', 4, 'latin1')
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length)
  // Before the first IDAT, where the PNG spec places it.
  return Buffer.concat([png.subarray(0, at), chunk, png.subarray(at)])
}
