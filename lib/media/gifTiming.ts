/**
 * A GIF's timing as a browser plays it, and the ffmpeg encode that keeps it.
 * PURE — no imports — so the browser transcoder (transcodeGif.ts, ffmpeg.wasm
 * 5.1) and the server's (transcodeGifNode.ts, the runtime image's ffmpeg) share
 * one reading of the file.
 *
 * ── Why the MP4 needs telling ──
 *
 * Left to itself, ffmpeg gets a GIF's timing wrong in ways that differ by
 * version. ffmpeg.wasm (5.1) ends the MP4 at the START of the last frame, so a
 * GIF that holds its final frame for 1.5 s shows it for a hundredth of a
 * second. The runtime image's ffmpeg (8.1) keeps that hold but snaps frames
 * to a guessed rate, loses time under B-frame reordering when the delays are
 * uneven, and plays a 1/100 s delay literally where every browser shows 1/10.
 * Measured on a 100-frame GIF of mostly 40 ms frames, 300 ms beats and a 1.5 s
 * final hold (7.8 s): 6.32 s from the browser path, 6.34 s from the server's.
 *
 * So the timing is read here and the encode is told it: every frame's delay
 * as a browser plays it, written back into the bytes ffmpeg reads; a constant
 * frame rate on the GIF's own time grid (100 / the delays' greatest common
 * divisor, so every delay is a whole number of frames — a GIF of even delays
 * keeps its own frame count); its last frame held for its delay; and the
 * whole trimmed at the GIF's true length. At a constant rate every frame,
 * the last included, lasts one step on every version, which is what makes
 * the end exact. Verified frame by frame on ffmpeg 7.1.1 and 8.1.2
 * (scripts/verify-gif-transcode.ts); on the browser's 5.1.4 (wasm) the
 * experience E2E checks each uploaded clip's length, frame count and keyframe
 * interval.
 */

export interface GifTiming {
  /** The GIF as ffmpeg should read it: each frame's delay written as a browser
   *  plays it, and one given to any frame that had none. */
  bytes: Uint8Array
  /** Each frame's delay in hundredths of a second, as a browser plays it. */
  delays: number[]
}

/** Browsers play a delay under 2/100 s — or none — as 1/10 s. */
const MIN_DELAY = 2
const DEFAULT_DELAY = 10

/**
 * Walk a GIF's blocks for its frames' delays. Null when the bytes are not a
 * GIF this can walk (an unknown block, or no frames), in which case the
 * caller encodes as it would have without it.
 */
export function readGifTiming(src: Uint8Array): GifTiming | null {
  if (src.length < 13 || src[0] !== 0x47 || src[1] !== 0x49 || src[2] !== 0x46) return null
  const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0)
  const out: number[] = []
  const delays: number[] = []
  let i = 13 + table(src[10])
  const copy = (from: number) => {
    for (let k = from; k < i && k < src.length; k++) out.push(src[k])
  }
  for (let k = 0; k < i && k < src.length; k++) out.push(src[k])
  // Where the last graphic control extension's delay sits in `out`, until the
  // image it belongs to claims it.
  let pending: number | null = null
  const skipSubBlocks = () => {
    while (i < src.length && src[i] !== 0) i += src[i] + 1
    i++
  }
  while (i < src.length) {
    const start = i
    const block = src[i++]
    if (block === 0x3b) {
      out.push(0x3b)
      break
    }
    if (block === 0x21) {
      const gce = src[i] === 0xf9 && src[i + 1] === 4
      i++
      skipSubBlocks()
      if (gce) pending = out.length + 4
      copy(start)
    } else if (block === 0x2c) {
      if (pending === null) {
        // A frame with no control block of its own: give it one, at the delay
        // a browser plays it for, so no ffmpeg has to guess.
        out.push(0x21, 0xf9, 0x04, 0x00, DEFAULT_DELAY, 0x00, 0x00, 0x00)
        pending = out.length - 4
      }
      const delay = out[pending] | (out[pending + 1] << 8)
      const played = delay < MIN_DELAY ? DEFAULT_DELAY : delay
      out[pending] = played & 0xff
      out[pending + 1] = played >> 8
      delays.push(played)
      pending = null
      i += 9 + table(src[i + 8]) + 1
      skipSubBlocks()
      copy(start)
    } else {
      return null
    }
  }
  if (delays.length === 0) return null
  return { bytes: Uint8Array.from(out), delays }
}

/** A GIF's running time in seconds. */
export function gifSeconds(timing: GifTiming): number {
  return timing.delays.reduce((a, d) => a + d, 0) / 100
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/** Frames between keyframes when a GIF's timing is unknown — and the fewest
 *  on any grid, so a GIF of 30 fps or slower keyframes as it always has. */
export const GOP_FRAMES = 30

/**
 * The encode that keeps a GIF's timing: a filter to put first in the video
 * chain, the output's exact length (ffmpeg's `-t`), and its keyframe interval
 * (`-g`). The interval is about a second on the GIF's grid: a fine grid (uneven
 * delays can put a GIF on 100 frames a second) would otherwise keyframe every
 * third of a second, a fifth larger for no gain in seeking.
 */
export function gifTimingArgs(timing: GifTiming): { filter: string; duration: string; gop: number } {
  const step = timing.delays.reduce(gcd)
  const last = timing.delays[timing.delays.length - 1]
  return {
    filter: `fps=100/${step},tpad=stop_mode=clone:stop_duration=${(last / 100).toFixed(2)}`,
    duration: gifSeconds(timing).toFixed(2),
    gop: Math.max(GOP_FRAMES, Math.round(100 / step)),
  }
}
