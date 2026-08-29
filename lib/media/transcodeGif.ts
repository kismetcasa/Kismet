import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { reportClientError } from '@/lib/clientError'

// Past ~100MB, ffmpeg.wasm starts OOM'ing on phones. Bigger GIFs upload
// unchanged — proxy + edge cache still help.
const MAX_SOURCE_BYTES = 100 * 1024 * 1024

// ─── Why every ffmpeg call below is bounded ──────────────────────────────
// @ffmpeg/ffmpeg drives its Web Worker over postMessage and registers ONLY an
// `onmessage` handler — there is no `onerror`/`onmessageerror`. Every API call
// (load, writeFile, exec) returns a promise that settles solely when the worker
// posts a reply, so a worker that DIES — its chunk 404s after a deploy rotates
// hashes, or the OS reaps it under memory pressure — leaves that promise
// pending FOREVER. Nothing throws, so the caller's catch (which routes to the
// server transcode) never runs, the spinner never moves, and reportClientError
// never fires: the failure is invisible both to the artist and to us.
//
// Measured in a browser harness against this exact library version: a dead
// worker sat pending indefinitely with no error event of any kind, while
// calling terminate() turned that same pending promise into a catchable
// rejection in ~1ms. terminate() is therefore the lever — every guard below
// pulls it, then throws so the EXISTING fallback finally becomes reachable
// (server transcode for mint/edit, original file for collection covers).
//
// The per-operation guard keys on LIVENESS, not wall clock: ffmpeg emits
// `log`/`progress` continuously while it is genuinely working, so silence —
// not elapsed time — separates a dead worker from a slow encode. A plain
// deadline would abort legitimately-slow phone encodes and dump them onto the
// single-slot server transcoder (app/api/transcode-gif, MAX_CONCURRENT=1) for
// no reason. Verified: a 120-frame 5.3MB GIF encodes with zero trips.

// No bytes from the core/wasm fetch for this long ⇒ the download is dead, not
// slow. Stall-based so a slow-but-progressing cellular download still finishes.
const CORE_FETCH_STALL_MS = 20_000
// Wall clock for worker spawn + wasm instantiation. Purely local CPU work once
// the bytes are in hand, so this is generous rather than tuned.
const LOAD_TIMEOUT_MS = 45_000
// No log/progress event from a running operation for this long ⇒ dead worker.
const OP_STALL_MS = 60_000

let ffmpegPromise: Promise<FFmpeg> | null = null
// The instance behind `ffmpegPromise`, held so a guard can terminate it.
let activeFFmpeg: FFmpeg | null = null

/**
 * Drop the cached singleton and kill its worker, so the NEXT attempt starts
 * clean. Both halves matter: a *rejected* promise left in `ffmpegPromise`
 * would silently route every later GIF in the session to the server fallback,
 * and a *terminated* instance left there would reject every later call.
 *
 * `expected` guards against killing a newer instance: a guard that fires late
 * (after some other caller already rebuilt the singleton) must only clean up
 * its own instance.
 */
function disposeFFmpeg(expected?: FFmpeg): void {
  if (expected && activeFFmpeg !== expected) {
    try { expected.terminate() } catch {}
    return
  }
  const ff = activeFFmpeg
  activeFFmpeg = null
  ffmpegPromise = null
  if (ff) {
    try { ff.terminate() } catch {}
  }
}

/**
 * Fetch one ffmpeg-core asset and hand back a blob: URL.
 *
 * Replaces @ffmpeg/util's toBlobURL, which (a) never checks `response.ok`, so
 * a 404 HTML body becomes a "core" blob that fails opaquely much later, and
 * (b) has no timeout at all, so a stalled fetch of the ~31MB wasm strands the
 * whole transcode behind a spinner showing no percentage. Reporting progress
 * here is what makes the load phase visible: before this, everything from the
 * first byte to the first encoded frame was one motionless toast.
 */
async function fetchCoreAsset(
  url: string,
  mime: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const controller = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(stall)
    stall = setTimeout(() => controller.abort(), CORE_FETCH_STALL_MS)
  }
  arm()
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
    // No streamable body (older engines): one buffered read, no progress.
    if (!res.body) {
      const buf = await res.arrayBuffer()
      return URL.createObjectURL(new Blob([buf], { type: mime }))
    }
    const total = Number(res.headers.get('content-length') ?? 0)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      arm()
      chunks.push(value)
      received += value.length
      // content-length is the ENCODED size when the asset is served
      // compressed, so it only ever drives a coarse hint — clamp under 100
      // and let the explicit 100 below land when the stream actually ends.
      if (total > 0 && onProgress) {
        onProgress(Math.min(99, Math.round((received / total) * 100)))
      }
    }
    onProgress?.(100)
    return URL.createObjectURL(new Blob(chunks as unknown as BlobPart[], { type: mime }))
  } finally {
    clearTimeout(stall)
  }
}

/** Lazy ffmpeg.wasm singleton. Single-threaded — callers must
 *  serialise (no concurrent ff.exec).
 *
 *  `onPrepareProgress` reports the core/wasm download (0-100). It only fires
 *  on the first call of a session; afterwards the singleton is already warm. */
export async function getFFmpeg(
  onPrepareProgress?: (pct: number) => void,
): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    const p = (async () => {
      // Dynamic-imported so the ~110KB JS + 31MB wasm only loads when a
      // user actually picks a GIF. Self-hosted under /ffmpeg-core/ (copied
      // out of @ffmpeg/core by scripts/copy-ffmpeg-core.mjs at install).
      const { FFmpeg } = await import('@ffmpeg/ffmpeg')
      // Sequential, not parallel: the ~112KB core is a rounding error next to
      // the ~31MB wasm, and interleaving two progress streams into one
      // percentage would read as the bar jumping backwards.
      const coreURL = await fetchCoreAsset('/ffmpeg-core/ffmpeg-core.js', 'text/javascript')
      const wasmURL = await fetchCoreAsset('/ffmpeg-core/ffmpeg-core.wasm', 'application/wasm', onPrepareProgress)
      const ff = new FFmpeg()
      activeFFmpeg = ff
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          ff.load({ coreURL, wasmURL }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              timedOut = true
              // Rejects the pending load (see the note at the top of this
              // file) so the race settles even when the worker never replies.
              try { ff.terminate() } catch {}
              reject(new Error('ffmpeg failed to start'))
            }, LOAD_TIMEOUT_MS)
          }),
        ])
      } catch (err) {
        // terminate() rejects the in-flight load first, so on a timeout the
        // race usually settles with the SDK's "called FFmpeg.terminate()".
        // Normalise it, or the cause would be unattributable in telemetry.
        if (timedOut) {
          reportClientError('ffmpeg_load_timeout', { budgetMs: LOAD_TIMEOUT_MS })
          throw new Error('ffmpeg failed to start')
        }
        throw err
      } finally {
        clearTimeout(timer)
      }
      return ff
    })()
    ffmpegPromise = p
    // Never cache a rejected load: without this, one failed start sends every
    // later GIF in the session down the fallback with no way back.
    p.catch(() => {
      if (ffmpegPromise === p) disposeFFmpeg()
    })
  }
  return ffmpegPromise
}

/**
 * Run one ffmpeg worker call under a liveness guard. If the worker emits
 * neither a log nor a progress event for OP_STALL_MS, treat it as dead:
 * terminate (which rejects this call), drop the singleton, and throw a
 * labelled error so telemetry names the phase that died.
 *
 * Exported because probeDuration and remuxFaststart drive the same shared
 * singleton and carry the identical hang exposure — probeDurationSeconds in
 * particular is awaited by MintForm's Promise.all, so a hang there would
 * freeze a video mint at "Uploading metadata…".
 */
export async function runWatched<T>(
  ff: FFmpeg,
  label: string,
  run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stalled = false
  let settled = false
  const arm = () => {
    if (settled) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      try { ff.terminate() } catch {}
      disposeFFmpeg(ff)
    }, OP_STALL_MS)
  }
  const onEvent = () => arm()
  ff.on('log', onEvent)
  ff.on('progress', onEvent)
  arm()
  try {
    return await run()
  } catch (err) {
    if (stalled) {
      reportClientError('ffmpeg_op_stalled', { op: label, stallMs: OP_STALL_MS })
      throw new Error(`ffmpeg ${label} stalled`)
    }
    throw err
  } finally {
    settled = true
    clearTimeout(timer)
    ff.off('log', onEvent)
    ff.off('progress', onEvent)
  }
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
export async function extractGifPoster(
  file: File,
  onPrepareProgress?: (pct: number) => void,
): Promise<File> {
  const ff = await getFFmpeg(onPrepareProgress)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await runWatched(ff, 'cover write', () => ff.writeFile('in.gif', bytes))
    await runWatched(ff, 'cover poster', () => ff.exec([
      '-i', 'in.gif',
      '-vf', 'select=eq(n\\,0)',
      '-vframes', '1',
      '-q:v', '5',
      'poster.jpg',
    ]))
    const posterBytes = (await runWatched(ff, 'cover read', () => ff.readFile('poster.jpg'))) as Uint8Array
    if (posterBytes.byteLength === 0) throw new Error('ffmpeg produced empty poster')
    const base = file.name.replace(/\.gif$/i, '') || 'cover'
    return new File([posterBytes as BlobPart], `${base}.jpg`, { type: 'image/jpeg' })
  } finally {
    // No guard needed here: terminate() nulls the worker handle, so every
    // deleteFile after a tripped watchdog rejects immediately rather than
    // waiting on a reply that will never come.
    for (const f of ['in.gif', 'poster.jpg']) {
      try { await ff.deleteFile(f) } catch {}
    }
  }
}

/**
 * Transcode a GIF to MP4 (H.264 yuv420p, faststart, even dims for browser
 * compat) + extract frame 0 as a JPEG poster. Throws on any ffmpeg
 * failure — including a stalled worker — and the caller falls back to the
 * original (mint/edit hand off to the server transcoder).
 *
 * `onProgress` reports the encode (0-100); `onPrepareProgress` reports the
 * one-time core/wasm download that precedes it. Two callbacks rather than one
 * because they are different phases: conflating them made the download look
 * like a frozen encode, which is exactly how this failure was first reported.
 */
export async function transcodeGifToMp4(
  file: File,
  onProgress: (pct: number) => void = () => {},
  onPrepareProgress?: (pct: number) => void,
): Promise<{ mp4: File; poster: File }> {
  const ff = await getFFmpeg(onPrepareProgress)
  const progressHandler = ({ progress }: { progress: number }) => {
    onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))))
  }
  ff.on('progress', progressHandler)
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await runWatched(ff, 'gif write', () => ff.writeFile('in.gif', bytes))
    await runWatched(ff, 'gif poster', () => ff.exec([
      '-i', 'in.gif',
      '-vf', 'select=eq(n\\,0)',
      '-vframes', '1',
      '-q:v', '5',
      'poster.jpg',
    ]))
    await runWatched(ff, 'gif encode', () => ff.exec([
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
    ]))
    const mp4Bytes = (await runWatched(ff, 'gif read', () => ff.readFile('out.mp4'))) as Uint8Array
    const posterBytes = (await runWatched(ff, 'gif read poster', () => ff.readFile('poster.jpg'))) as Uint8Array
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
