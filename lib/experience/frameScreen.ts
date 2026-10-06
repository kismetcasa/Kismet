import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { fetchGatewayResolved } from '@/lib/media/gatewayFetch'
import {
  FLASH_DECODE_FILTER,
  FLASH_GRID,
  FLASH_RATE,
  flashReason,
  isAnimatedImage,
  isSvg,
  screenFlashes,
} from '@/lib/media/flashScreen'
import { redis } from '@/lib/redis'
import { acquireLock } from '@/lib/redisLock'
import { getMachine, setFrameCheck } from './store'
import { FRAME_LIMITS, type FrameCheck, type MachineFrames, type StageFrame } from './types'

/**
 * The server's screening of an artist's stage frames: the gate between a
 * frame being saved and a player seeing it.
 *
 * The studio screens a frame when it is picked (lib/experience/frameUpload),
 * but a frame reaches the machine as an ar:// address in a request the
 * creator's browser makes, so nothing it checked is known here. So the server
 * fetches what was uploaded and checks it again, against FRAME_LIMITS and for
 * flashing (lib/media/flashScreen, WCAG 2.3.1), and a frame is played only
 * once it has passed (cover.playerFrames). Until then the stage plays the
 * platform's capsule; a frame that fails is kept for its creator to see why.
 *
 * A frame that cannot be fetched yet (a gateway still settling, or down) or
 * checked here (no ffmpeg) is left unchecked, and tried again when the
 * machine is next read — never passed for want of a look.
 */

/** A gateway tried before the pool — the E2E points it at its own. */
const SCREEN_GATEWAY = process.env.ARWEAVE_GATEWAY_URL?.replace(/\/+$/, '')
/** How long one frame's fetch may take across every gateway. */
const FETCH_BUDGET_MS = 20_000
/** How long ffmpeg may take to decode one frame. */
const DECODE_TIMEOUT_MS = 60_000
/** The longest a frame may run, and a little over: container durations round
 *  up a frame or so, as the studio allows. */
const MAX_SECONDS = FRAME_LIMITS.seconds + 0.1
/** Frames decoded at most: past this a clip is too long whatever it says. */
const MAX_DECODED = (FRAME_LIMITS.seconds + 1) * FLASH_RATE

type Fetched = Buffer | 'too-large' | null

/** An ar:// upload's bytes, at most `maxBytes`; null when no gateway had them. */
async function fetchUpload(uri: string, maxBytes: number): Promise<Fetched> {
  // Only an Arweave upload — parseFrames admits nothing else — and only
  // through a gateway: never a URL a request supplied.
  if (!uri.startsWith('ar://')) return null
  const urls = [...(SCREEN_GATEWAY ? [`${SCREEN_GATEWAY}/${uri.slice(5)}`] : []), ...gatewayUrls(uri)]
  const signal = AbortSignal.timeout(FETCH_BUDGET_MS)
  for (const url of urls) {
    try {
      const res = await fetchGatewayResolved(url, undefined, signal)
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
        await res.body?.cancel()
        return 'too-large'
      }
      if (!res.body) continue
      const chunks: Uint8Array[] = []
      let size = 0
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
          await reader.cancel()
          return 'too-large'
        }
        chunks.push(value)
      }
      return Buffer.concat(chunks)
    } catch {
      // The next gateway, or none.
    }
  }
  return null
}

/** A clip decoded for flashScreen, with what its container says of it. */
type Decoded = { rgb: Uint8Array; seconds: number; side: number }

/** Decode a clip with the runtime image's ffmpeg: 'unreadable' when it is not
 *  a video ffmpeg can read, null when there is no ffmpeg to read it with. */
async function decode(media: Buffer): Promise<Decoded | 'unreadable' | null> {
  const dir = await mkdtemp(join(tmpdir(), 'frame-screen-'))
  const input = join(dir, 'in')
  try {
    await writeFile(input, media)
    const frameBytes = FLASH_GRID * FLASH_GRID * 3
    const run = await new Promise<{ stdout: Buffer; stderr: string } | 'unreadable' | null>((resolve) => {
      execFile(
        'ffmpeg',
        ['-hide_banner', '-nostdin', '-v', 'info', '-i', input, '-frames:v', String(MAX_DECODED),
          '-vf', FLASH_DECODE_FILTER, '-an', '-f', 'rawvideo', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: (MAX_DECODED + 2) * frameBytes, timeout: DECODE_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => {
          if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(null)
          if (err) return resolve('unreadable')
          resolve({ stdout, stderr: stderr.toString() })
        },
      )
    })
    if (run === null || run === 'unreadable') return run
    const frames = Math.floor(run.stdout.length / frameBytes)
    if (frames === 0) return 'unreadable'
    const duration = run.stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/)
    const size = run.stderr.match(/Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/)
    return {
      rgb: new Uint8Array(run.stdout.buffer, run.stdout.byteOffset, frames * frameBytes),
      // A container that does not say how long it runs is as long as it decodes.
      seconds: duration ? +duration[1] * 3600 + +duration[2] * 60 + parseFloat(duration[3]) : frames / FLASH_RATE,
      side: size ? Math.max(+size[1], +size[2]) : 0,
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')

/**
 * Screen one frame for the stage it plays on: a verdict, or null when it
 * could not be looked at yet. `fetchBytes` exists for the verify script.
 */
export async function screenFrame(
  frame: StageFrame,
  stage: keyof MachineFrames,
  fetchBytes: (uri: string, maxBytes: number) => Promise<Fetched> = fetchUpload,
): Promise<FrameCheck | null> {
  const refuse = (reason: string): FrameCheck => ({ state: 'refused', reason, at: Date.now() })
  const tooLarge = `larger than ${mb(FRAME_LIMITS.bytes)} MB`
  const media = await fetchBytes(frame.uri, FRAME_LIMITS.bytes)
  if (media === null) return null
  if (media === 'too-large') return refuse(`It is ${tooLarge}`)
  if (frame.kind === 'image' && isAnimatedImage(media)) {
    return refuse('It moves — an animated frame is a gif or a video, which are checked for flashing')
  }
  if (frame.kind === 'image' && isSvg(media)) {
    return refuse('It is an SVG, which can move by itself — a still is a png, jpg or webp')
  }
  const poster = frame.poster === frame.uri ? media : await fetchBytes(frame.poster, FRAME_LIMITS.bytes)
  if (poster === null) return null
  if (poster === 'too-large') return refuse(`Its still is ${tooLarge}`)
  if (isAnimatedImage(poster)) return refuse('Its still moves — a still is one image')
  if (isSvg(poster)) return refuse('Its still is an SVG, which can move by itself — a still is a png, jpg or webp')

  if (frame.kind === 'image') {
    const meta = await sharp(media).metadata().catch(() => null)
    if (!meta?.width || !meta.height) return refuse('It could not be read as an image')
    const side = Math.max(meta.width, meta.height)
    if (side > FRAME_LIMITS.px) return refuse(`It is ${side} px on its longest side — at most ${FRAME_LIMITS.px}`)
    return { state: 'passed', at: Date.now() }
  }

  const clip = await decode(media)
  if (clip === null) return null
  if (clip === 'unreadable') return refuse('It could not be read as a video')
  if (clip.seconds > MAX_SECONDS) return refuse(`It runs ${clip.seconds.toFixed(1)} seconds — at most ${FRAME_LIMITS.seconds}`)
  if (clip.side > FRAME_LIMITS.px) return refuse(`It is ${clip.side} px on its longest side — at most ${FRAME_LIMITS.px}`)
  const verdict = screenFlashes(clip.rgb, { loop: stage === 'dispense' })
  return verdict.ok ? { state: 'passed', at: Date.now() } : refuse(flashReason(verdict))
}

// One decode at a time: ffmpeg is the box's heaviest tenant (see
// /api/transcode-gif), and screening is never in a hurry.
let turn: Promise<unknown> = Promise.resolve()
function serially<T>(job: () => Promise<T>): Promise<T> {
  const run = turn.then(job)
  turn = run.catch(() => {})
  return run
}

/** Whether any of a machine's frames still waits on a verdict. */
export function screeningDue(frames: MachineFrames | undefined): boolean {
  return !!frames && Object.values(frames).some((f) => f && !f.check)
}

/**
 * Screen every frame of a machine that has no verdict yet, and record each
 * verdict against the frame it was reached for — a frame changed meanwhile
 * keeps waiting for its own.
 */
export async function screenMachineFrames(id: string): Promise<void> {
  const lock = await acquireLock(`kismetart:lock:xp-frames:${id}`, 180).catch(() => null)
  if (!lock?.acquired) return
  try {
    const machine = await getMachine(id)
    for (const stage of ['dispense', 'open'] as const) {
      const frame = machine?.frames?.[stage]
      if (!frame || frame.check) continue
      const check = await serially(() => screenFrame(frame, stage)).catch(() => null)
      if (check) await setFrameCheck(id, stage, frame.uri, check)
    }
  } finally {
    await lock.release()
  }
}

/** Screen a machine's waiting frames after a read, at most every half minute,
 *  so a gateway that is not ready yet is not asked on every page view. */
export async function screenMachineFramesSoon(id: string): Promise<void> {
  const due = await redis.set(`kismetart:xp:frames-retry:${id}`, '1', { nx: true, ex: 30 }).catch(() => null)
  if (due === 'OK') await screenMachineFrames(id)
}
