import { GLB_HEADER_BYTES, GLB_MIME, hasGlbMagic } from '../glbFormat.ts'
import { formatCfileSize } from '../collectorFileTypes.ts'

/**
 * The artwork page's own GLB download (components/MomentModel), replacing the
 * fetch `<model-viewer>` would otherwise make for itself. Pure — no DOM, no
 * React — so scripts/verify-model-fetch.ts can pin it against a mocked fetch.
 *
 * WHY WE DOWNLOAD THE MODEL OURSELVES. Verified against the installed
 * @google/model-viewer 4.3.1 and the three.js it bundles, and reproduced in a
 * browser harness (GLB_3D_VIEWER_DESIGN.md, "The artist's fourth round"):
 *
 *   - Its `progress` event is an AGGREGATE of every activity. The lighting
 *     environment is generated in the renderer and completes in
 *     milliseconds, which alone moves `totalProgress` to exactly 0.5 — so the
 *     readout said "50%" before a single model byte had arrived, and a
 *     gateway that accepted the connection and never sent a byte left it
 *     there forever. A body without Content-Length jumps to 88% instead.
 *   - It has NO timeout and NO way to abort (google/model-viewer#2593, open
 *     since 2021: removing the element does not stop the download). three.js
 *     gained `FileLoader.abort()` in r179; model-viewer never calls it.
 *   - It CACHES A FAILED LOAD as an empty model, keyed by URL, and exposes no
 *     way to clear that cache — a second mount of the same `src` errors
 *     instantly with zero network requests. "retry 3D" could never re-fetch
 *     within a page session.
 *   - Chrome serialises a second identical GET behind the first for up to
 *     20 s (the HTTP cache lock), so "just set src again" is also slow.
 *
 * Owning the request fixes all four: an AbortController the exit button and
 * the stall watchdog can fire, byte-counted progress from the stream (honest
 * "4.2 of 28.0 MB", never a phantom 50%), a gateway walk on failure, and a
 * fresh blob: URL per attempt so model-viewer's caches never see a stale or
 * failed entry. The cost is one transient extra copy of the file (the Blob)
 * while model-viewer parses it — released on `load`. At the 30 MB mint cap
 * that is inside the memory budget the design already accepts for parsing.
 */

/** No bytes for this long aborts the attempt and walks on. Time-to-first-
 *  byte counts: this is the case the artist actually hit (a gateway that
 *  accepted the connection and sent nothing). */
export const MODEL_FETCH_STALL_MS = 20_000
/** Hard ceiling on one attempt, however slowly bytes trickle. A 30 MB model
 *  on a 1 Mbit/s link needs ~4 minutes; slower than that is not a viewer. */
export const MODEL_FETCH_TIMEOUT_MS = 5 * 60_000
/** Refuse bodies past this. Mints are capped at MODEL_MAX_BYTES (30 MB), but
 *  metadata can point at any file; a 500 MB "model" must not be buffered on
 *  a phone. Twice the mint cap leaves room for older or external mints. */
export const MODEL_FETCH_MAX_BYTES = 64 * 1024 * 1024

export interface ModelFetchProgress {
  /** Bytes received so far on the current attempt. */
  loaded: number
  /** Total bytes when the response declared a Content-Length, else null. */
  total: number | null
  /** 0-based index into `urls` of the attempt reporting. */
  attempt: number
}

export type ModelFetchFailure =
  | { kind: 'http'; status: number }
  | { kind: 'stall' }
  | { kind: 'timeout' }
  | { kind: 'network'; message: string }
  | { kind: 'too-large'; bytes: number }
  | { kind: 'not-glb' }

export interface ModelFetchAttempt {
  url: string
  failure: ModelFetchFailure
}

/** Every URL failed. `attempts` records each URL's reason, in order. */
export class ModelFetchError extends Error {
  readonly attempts: ModelFetchAttempt[]
  constructor(attempts: ModelFetchAttempt[]) {
    super(describeModelFetchFailure(attempts))
    this.name = 'ModelFetchError'
    this.attempts = attempts
  }
}

/**
 * The copy for an exhausted walk. Actionable where the cause is: a stall or
 * timeout anywhere in the walk is a connection/gateway problem worth a retry;
 * an oversized file is not; everything else is the model itself.
 */
export function describeModelFetchFailure(attempts: ModelFetchAttempt[]): string {
  const tooLarge = attempts.find((a) => a.failure.kind === 'too-large')
  if (tooLarge && tooLarge.failure.kind === 'too-large') {
    return `This 3D model is too large to load in the browser (${formatCfileSize(tooLarge.failure.bytes)}).`
  }
  if (attempts.some((a) => a.failure.kind === 'stall' || a.failure.kind === 'timeout')) {
    return 'The 3D model is taking too long to load — check your connection and retry.'
  }
  return 'This 3D model could not be loaded.'
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

export interface FetchModelOptions {
  onProgress?: (progress: ModelFetchProgress) => void
  /** The caller's cancel (exit button, unmount). Aborting it throws an
   *  AbortError out of fetchModelBlob without trying further URLs. */
  signal?: AbortSignal
  stallMs?: number
  timeoutMs?: number
  maxBytes?: number
  /** Injectable for the verify script; production callers omit it. */
  fetchImpl?: typeof fetch
}

export interface FetchedModel {
  blob: Blob
  /** The URL that succeeded. */
  url: string
  bytes: number
  /** How many URLs were tried, the successful one included. */
  attempts: number
}

function abortError(): DOMException {
  return new DOMException('The 3D model load was cancelled', 'AbortError')
}

/**
 * Download a GLB, trying each URL in order until one yields a whole, valid
 * body. Per attempt: one fetch with its own AbortController, a stall
 * watchdog reset on every chunk, a hard timeout, a byte cap, and a magic-byte
 * check on the first four bytes (a gateway's HTML landing page must never be
 * handed to model-viewer as a model). A failure records why and moves on; the
 * caller's `signal` aborting stops the walk immediately.
 */
export async function fetchModelBlob(
  urls: readonly string[],
  opts: FetchModelOptions = {},
): Promise<FetchedModel> {
  const {
    onProgress,
    signal,
    stallMs = MODEL_FETCH_STALL_MS,
    timeoutMs = MODEL_FETCH_TIMEOUT_MS,
    maxBytes = MODEL_FETCH_MAX_BYTES,
    fetchImpl = fetch,
  } = opts
  const attempts: ModelFetchAttempt[] = []

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    if (signal?.aborted) throw signal.reason ?? abortError()

    const attempt = new AbortController()
    let failure: ModelFetchFailure | null = null
    // First cause wins: a stall firing while the timeout is also pending must
    // not be overwritten by whichever timer the event loop runs second.
    const fail = (f: ModelFetchFailure) => {
      if (!failure) failure = f
      attempt.abort()
    }
    const onOuterAbort = () => attempt.abort()
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timeout = setTimeout(() => fail({ kind: 'timeout' }), timeoutMs)
    let stall = setTimeout(() => fail({ kind: 'stall' }), stallMs)
    const armStall = () => {
      clearTimeout(stall)
      stall = setTimeout(() => fail({ kind: 'stall' }), stallMs)
    }

    try {
      const res = await fetchImpl(url, { signal: attempt.signal, credentials: 'omit' })
      if (!res.ok) {
        failure = { kind: 'http', status: res.status }
        void res.body?.cancel().catch(() => {})
        continue
      }
      const declared = res.headers.get('content-length')
      const total = declared && /^\d+$/.test(declared) ? Number(declared) : null
      if (total !== null && total > maxBytes) {
        failure = { kind: 'too-large', bytes: total }
        void res.body?.cancel().catch(() => {})
        continue
      }
      if (!res.body) {
        failure = { kind: 'network', message: 'empty response' }
        continue
      }

      // Headers are in: the connection is real. From here the watchdog
      // measures bytes, not the handshake.
      armStall()
      onProgress?.({ loaded: 0, total, attempt: i })

      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      const head = new Uint8Array(GLB_HEADER_BYTES)
      let headLen = 0
      let magicOk = false
      let loaded = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armStall()
        loaded += value.byteLength
        if (loaded > maxBytes) {
          fail({ kind: 'too-large', bytes: loaded })
          void reader.cancel().catch(() => {})
          break
        }
        if (headLen < GLB_HEADER_BYTES) {
          const n = Math.min(GLB_HEADER_BYTES - headLen, value.byteLength)
          head.set(value.subarray(0, n), headLen)
          headLen += n
        }
        // Decide on the very first bytes rather than after the whole body:
        // an HTML fallback page or a wrong file should cost a few KB, not
        // a full download, before the walk moves on.
        if (!magicOk && headLen >= 4) {
          if (!hasGlbMagic(head.subarray(0, headLen))) {
            fail({ kind: 'not-glb' })
            void reader.cancel().catch(() => {})
            break
          }
          magicOk = true
        }
        chunks.push(value)
        onProgress?.({ loaded, total, attempt: i })
      }
      if (failure) continue
      if (!magicOk) {
        // Fewer than four bytes in total: empty or truncated beyond use.
        failure = { kind: 'not-glb' }
        continue
      }
      return { blob: new Blob(chunks, { type: GLB_MIME }), url, bytes: loaded, attempts: i + 1 }
    } catch (err) {
      // The caller cancelled: propagate, and do not try another URL.
      if (signal?.aborted) throw signal.reason ?? abortError()
      // Our own watchdog aborted the attempt: `failure` already says why.
      if (!failure) {
        failure = { kind: 'network', message: err instanceof Error ? err.message : String(err) }
      }
    } finally {
      clearTimeout(timeout)
      clearTimeout(stall)
      signal?.removeEventListener('abort', onOuterAbort)
      // Recorded here, not after the try: the `continue`s above skip
      // anything below the block, and a walk that forgets why a URL failed
      // reports the wrong copy at the end.
      if (failure) attempts.push({ url, failure })
    }
  }

  throw new ModelFetchError(attempts)
}

/**
 * The readout under the still while a model is on its way — three explicit
 * steps, never a phantom number: "connecting" until the response's headers
 * arrive, real bytes (with a percentage only when the server declared a
 * total) while they flow, "preparing" while model-viewer parses the blob.
 * NN/g's guidance for waits past ten seconds is a percent-done figure or
 * named steps; a bare spinner is not enough at the sizes a 3D model reaches.
 */
export function modelLoadReadout(download: ModelFetchProgress | null, parsing: boolean): string {
  if (parsing) return 'preparing'
  if (!download) return 'connecting'
  const { loaded, total } = download
  if (total !== null && total > 0) {
    const pct = Math.min(100, Math.round((loaded / total) * 100))
    return `${pct}% · ${formatCfileSize(loaded)} of ${formatCfileSize(total)}`
  }
  return formatCfileSize(loaded)
}
