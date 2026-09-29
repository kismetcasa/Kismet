import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { checkMintMedia } from '@/lib/media/mintMedia'
import { transcodeGifToMp4 } from '@/lib/media/transcodeGif'
import { remuxToFaststartMp4 } from '@/lib/media/remuxFaststart'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { probeDurationSeconds } from '@/lib/media/probeDuration'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { FRAME_LIMITS, type StageFrame } from './types'

/**
 * An artist's frame for one stage of a play, prepared the way a mint's media
 * is (MintForm): a gif becomes an H.264 mp4 and its first frame, a video is
 * remuxed to start fast and gives up a still, an image is its own still. Then
 * it is held to what a stage can afford (FRAME_LIMITS) — before anything is
 * uploaded, so a frame that will not do costs a toast, not an upload.
 *
 * One departure from the mint: a gif the browser cannot transcode is refused
 * rather than handed to the server's transcoder, which exists for gifs past
 * the browser's 100 MB ceiling — far past anything that fits a frame.
 */

export interface PreparedFrame {
  media: File
  /** Its still; the media itself for an image. */
  poster: File
  kind: StageFrame['kind']
}

/** ffmpeg.wasm is one worker that runs one job at a time (getFFmpeg: "callers
 *  must serialise"), and a machine's media reaches it from two places — a frame
 *  prepared as it is picked, a cover's first frame taken on publish — so each
 *  waits its turn here. */
let turn: Promise<unknown> = Promise.resolve()
export function serially<T>(job: () => Promise<T>): Promise<T> {
  const run = turn.then(job)
  turn = run.catch(() => {})
  return run
}

export function prepareFrame(file: File): Promise<PreparedFrame | string> {
  return serially(() => prepare(file))
}

async function prepare(file: File): Promise<PreparedFrame | string> {
  const verdict = await checkMintMedia(file)
  if (!verdict.ok) return verdict.reason
  if (verdict.kind === 'model') return 'Use an image, a gif or a video'
  let frame: PreparedFrame
  let seconds: number | null = null
  if (file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif')) {
    seconds = gifSeconds(new Uint8Array(await file.arrayBuffer()))
    try {
      const { mp4, poster } = await transcodeGifToMp4(file)
      frame = { media: mp4, poster, kind: 'video' }
    } catch {
      return 'This gif could not be prepared — try it again, or as an mp4'
    }
  } else if (verdict.kind === 'video') {
    const media = (await remuxToFaststartMp4(file).catch(() => null)) ?? file
    const poster = await extractVideoPoster(file)
    if (!poster) return 'This video could not be read here — try an mp4'
    frame = { media, poster, kind: 'video' }
    seconds = await probeDurationSeconds(media)
  } else {
    frame = { media: file, poster: file, kind: 'image' }
  }
  return (await overLimit(frame, seconds)) ?? frame
}

/**
 * A gif's running time: its frames' delays summed, each as a browser and
 * ffmpeg show it (a delay under 2/100 s plays as 1/10). Read from the gif and
 * not from the mp4 it becomes, which ffmpeg ends at its last frame's START —
 * a gif of two 2.5 s frames measures 2.51 s as an mp4. Null when the bytes are
 * not a gif this can walk.
 */
export function gifSeconds(b: Uint8Array): number | null {
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null
  const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0)
  let i = 13 + table(b[10])
  let hundredths = 0
  const skipSubBlocks = () => {
    while (i < b.length && b[i] !== 0) i += b[i] + 1
    i++
  }
  while (i < b.length) {
    const block = b[i++]
    if (block === 0x3b) break
    if (block === 0x21) {
      // An extension; a graphic control one carries the next frame's delay.
      if (b[i] === 0xf9 && b[i + 1] === 4) {
        const delay = b[i + 3] | (b[i + 4] << 8)
        hundredths += delay < 2 ? 10 : delay
      }
      i++
      skipSubBlocks()
    } else if (block === 0x2c) {
      // An image: its descriptor, any local colour table, then its data.
      i += 9 + table(b[i + 8]) + 1
      skipSubBlocks()
    } else {
      return null
    }
  }
  return hundredths > 0 ? hundredths / 100 : null
}

async function overLimit(frame: PreparedFrame, seconds: number | null): Promise<string | null> {
  if (frame.media.size > FRAME_LIMITS.bytes) {
    return `Keep a frame to ${mb(FRAME_LIMITS.bytes)} MB — this one is ${mb(frame.media.size)} MB`
  }
  if (frame.kind === 'video') {
    if (seconds === null) return 'Could not tell how long this clip runs — try an mp4'
    // Container durations round up a frame or so; a 4 s export must pass.
    if (seconds > FRAME_LIMITS.seconds + 0.1) {
      return `Keep a frame to ${FRAME_LIMITS.seconds} seconds — this one runs ${seconds.toFixed(1)}`
    }
  }
  const still = await createImageBitmap(frame.poster).catch(() => null)
  if (!still) return 'This frame could not be read'
  const side = Math.max(still.width, still.height)
  still.close()
  if (side > FRAME_LIMITS.px) return `Keep a frame to ${FRAME_LIMITS.px} px on its longest side — this one is ${side}`
  return null
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')

/** Upload a prepared frame: the media, its still (once, for an image) and the
 *  still's thumbhash. */
export async function uploadFrame(frame: PreparedFrame): Promise<StageFrame> {
  const thumbhash = generateThumbhash(frame.poster)
  const uri = await uploadToArweave(frame.media)
  const poster = frame.poster === frame.media ? uri : await uploadToArweave(frame.poster)
  const hash = await thumbhash
  return { uri, kind: frame.kind, poster, ...(hash ? { thumbhash: hash } : {}) }
}
