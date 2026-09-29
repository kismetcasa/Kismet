import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { checkMintMedia } from '@/lib/media/mintMedia'
import { transcodeGifToMp4 } from '@/lib/media/transcodeGif'
import { remuxToFaststartMp4 } from '@/lib/media/remuxFaststart'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { probeDurationSeconds } from '@/lib/media/probeDuration'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { gifSeconds, readGifTiming } from '@/lib/media/gifTiming'
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
    // Read from the gif itself, as a browser plays it (lib/media/gifTiming).
    const timing = readGifTiming(new Uint8Array(await file.arrayBuffer()))
    seconds = timing ? gifSeconds(timing) : null
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
