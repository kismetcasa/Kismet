import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { checkMintMedia } from '@/lib/media/mintMedia'
import { getFFmpeg, runWatched, transcodeGifToMp4 } from '@/lib/media/transcodeGif'
import { remuxToFaststartMp4 } from '@/lib/media/remuxFaststart'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { probeDurationSeconds } from '@/lib/media/probeDuration'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { gifSeconds, readGifTiming } from '@/lib/media/gifTiming'
import { FLASH_DECODE_FILTER, FLASH_RATE, flashReason, isAnimatedImage, screenFlashes, type FlashVerdict } from '@/lib/media/flashScreen'
import { FRAME_LIMITS, type MachineFrames, type StageFrame } from './types'

/**
 * An artist's frame for one stage of a play, prepared the way a mint's media
 * is (MintForm): a gif becomes an H.264 mp4 and its first frame, a video is
 * remuxed to start fast and gives up a still, an image is its own still. Then
 * it is held to what a stage can afford (FRAME_LIMITS) and screened for
 * flashing (lib/media/flashScreen, WCAG 2.3.1) at the size the stage shows it,
 * looping if its stage loops — before anything is uploaded, so a frame that
 * will not do costs a toast, not an upload. An image that moves is refused
 * outright: the stage would show it as an image, animating unscreened. The
 * server screens every frame again before a player sees it
 * (lib/experience/frameScreen); this is the creator's early answer.
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

export function prepareFrame(file: File, stage: keyof MachineFrames): Promise<PreparedFrame | string> {
  return serially(() => prepare(file, stage))
}

async function prepare(file: File, stage: keyof MachineFrames): Promise<PreparedFrame | string> {
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
    if (isAnimatedImage(new Uint8Array(await file.arrayBuffer()))) {
      return 'This image moves — give an animation as a gif or a video, which are checked for flashing'
    }
    frame = { media: file, poster: file, kind: 'image' }
  }
  const over = await overLimit(frame, seconds)
  if (over) return over
  if (frame.kind === 'video') {
    const verdict = await screen(frame.media, stage === 'dispense')
    if (!verdict) return 'This clip could not be checked for flashing — try an mp4'
    if (!verdict.ok) return flashReason(verdict)
  }
  return frame
}

/** Decode a clip as flashScreen measures it, with the same ffmpeg the
 *  transcode uses, and screen it; null when it could not be decoded. */
async function screen(media: File, loop: boolean): Promise<FlashVerdict | null> {
  try {
    const ff = await getFFmpeg()
    const input = `screen-in.${media.name.split('.').pop() || 'mp4'}`
    await runWatched(ff, 'screen write', async () => ff.writeFile(input, new Uint8Array(await media.arrayBuffer())))
    try {
      await runWatched(ff, 'flash screen', () => ff.exec([
        '-i', input,
        '-frames:v', String((FRAME_LIMITS.seconds + 1) * FLASH_RATE),
        '-vf', FLASH_DECODE_FILTER,
        '-an', '-f', 'rawvideo', 'screen.rgb',
      ]))
      const rgb = (await runWatched(ff, 'screen read', () => ff.readFile('screen.rgb'))) as Uint8Array
      return rgb.byteLength > 0 ? screenFlashes(rgb, { loop }) : null
    } finally {
      for (const f of [input, 'screen.rgb']) await ff.deleteFile(f).catch(() => {})
    }
  } catch {
    return null
  }
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
