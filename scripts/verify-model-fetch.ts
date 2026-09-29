/**
 * Pins lib/media/modelFetch — the artwork page's own GLB download — against
 * a mocked fetch, so the behaviours that only ever showed up on a real
 * network (a gateway that never sends a byte, a body with no Content-Length,
 * an HTML fallback page, a cancel mid-download) have a deterministic oracle.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
 *        scripts/verify-model-fetch.ts
 */

import { GLB_MAGIC, GLB_MIME } from '../lib/glbFormat.ts'
import { modelFetchUrls } from '../lib/media/gateway.ts'
import {
  MODEL_FETCH_MAX_BYTES,
  ModelFetchError,
  describeModelFetchFailure,
  fetchModelBlob,
  isAbortError,
  modelLoadReadout,
  type ModelFetchProgress,
} from '../lib/media/modelFetch.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A GLB-looking body: the magic, then filler.
const glb = (size: number): Uint8Array => {
  const b = new Uint8Array(size)
  b.set(GLB_MAGIC)
  return b
}
const split = (b: Uint8Array, parts: number): Uint8Array[] => {
  const out: Uint8Array[] = []
  const step = Math.ceil(b.length / parts)
  for (let i = 0; i < b.length; i += step) out.push(b.subarray(i, i + step))
  return out
}

interface RouteSpec {
  status?: number
  chunks?: Uint8Array[]
  /** ms between chunks. */
  gapMs?: number
  /** Send headers, then never a byte. */
  hangBeforeBody?: boolean
  /** Send the chunks, then never close. */
  hangAfterBody?: boolean
  contentLength?: number | 'auto' | 'none'
  /** Never even answer the headers. */
  hangHeaders?: boolean
}

/** Build a mocked fetch. Streams honour the request's AbortSignal the way a
 *  real fetch does: an abort rejects the pending read and cancels the body. */
function mockFetch(routes: Record<string, RouteSpec>) {
  const calls: string[] = []
  const cancelled: string[] = []
  const impl: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    const spec = routes[url]
    if (!spec) return new Response('not found', { status: 404 })
    const signal = init?.signal ?? undefined
    if (spec.hangHeaders) {
      await new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }
    if (spec.status && spec.status >= 400) {
      return new Response('error', { status: spec.status })
    }
    const chunks = spec.chunks ?? []
    let closed = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          'abort',
          () => {
            if (closed) return
            closed = true
            // A real fetch releases the body when its signal aborts; that
            // is the "cancelled" the assertions below mean.
            cancelled.push(url)
            try {
              controller.error(new DOMException('aborted', 'AbortError'))
            } catch {
              /* already closed */
            }
          },
          { once: true },
        )
        void (async () => {
          if (spec.hangBeforeBody) return
          for (const c of chunks) {
            if (closed) return
            if (spec.gapMs) await sleep(spec.gapMs)
            if (closed) return
            controller.enqueue(c)
          }
          if (spec.hangAfterBody || closed) return
          closed = true
          controller.close()
        })()
      },
      cancel() {
        closed = true
        cancelled.push(url)
      },
    })
    const headers = new Headers({ 'content-type': GLB_MIME })
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const cl = spec.contentLength ?? 'auto'
    if (cl === 'auto') headers.set('content-length', String(total))
    else if (typeof cl === 'number') headers.set('content-length', String(cl))
    return new Response(stream, { status: spec.status ?? 200, headers })
  }
  return { impl, calls, cancelled }
}

const body = glb(10_000)

// ---- 1. Plain success with Content-Length: honest, monotonic progress ----
{
  const { impl, calls } = mockFetch({ 'a://1': { chunks: split(body, 4), gapMs: 2 } })
  const events: ModelFetchProgress[] = []
  const got = await fetchModelBlob(['a://1', 'a://2'], { fetchImpl: impl, onProgress: (p) => events.push(p) })
  check('success: one fetch, first url', calls.length === 1 && got.url === 'a://1' && got.attempts === 1)
  check('success: blob has every byte and the GLB MIME', got.bytes === 10_000 && got.blob.size === 10_000 && got.blob.type === GLB_MIME)
  check('success: first progress event is 0 of the declared total', events[0]?.loaded === 0 && events[0]?.total === 10_000)
  const monotonic = events.every((e, i) => i === 0 || e.loaded >= events[i - 1].loaded)
  check('success: progress is monotonic and ends at the total', monotonic && events.at(-1)?.loaded === 10_000)
  check('success: blob bytes start with the glTF magic', new Uint8Array(await got.blob.slice(0, 4).arrayBuffer()).every((b, i) => b === GLB_MAGIC[i]))
}

// ---- 2. No Content-Length: total is null, never a fake percentage ----
{
  const { impl } = mockFetch({ 'a://1': { chunks: split(body, 3), contentLength: 'none' } })
  const events: ModelFetchProgress[] = []
  const got = await fetchModelBlob(['a://1'], { fetchImpl: impl, onProgress: (p) => events.push(p) })
  check('no Content-Length: total is null on every event', events.length > 0 && events.every((e) => e.total === null))
  check('no Content-Length: still succeeds with all bytes', got.bytes === 10_000)
}

// ---- 3. HTTP failure walks to the next url ----
{
  const { impl, calls } = mockFetch({ 'a://1': { status: 502 }, 'a://2': { chunks: [body] } })
  const got = await fetchModelBlob(['a://1', 'a://2'], { fetchImpl: impl })
  check('502 on the first url walks to the second', calls.length === 2 && got.url === 'a://2' && got.attempts === 2)
}

// ---- 4. An HTML landing page is rejected on its first bytes, then walked ----
{
  const html = new TextEncoder().encode('<!doctype html><html><body>gateway</body></html>'.repeat(40))
  const { impl, calls, cancelled } = mockFetch({ 'a://1': { chunks: split(html, 5), gapMs: 5 }, 'a://2': { chunks: [body] } })
  const got = await fetchModelBlob(['a://1', 'a://2'], { fetchImpl: impl })
  check('HTML body is not accepted as a model; the walk continues', got.url === 'a://2' && calls.length === 2)
  check('HTML body was cancelled early rather than downloaded whole', cancelled.includes('a://1'))
}

// ---- 5. Headers then silence: the stall watchdog fires and walks ----
{
  const { impl, calls } = mockFetch({ 'a://1': { chunks: [body], hangBeforeBody: true }, 'a://2': { status: 404 } })
  const t0 = Date.now()
  let err: unknown
  try {
    await fetchModelBlob(['a://1', 'a://2'], { fetchImpl: impl, stallMs: 60, timeoutMs: 5_000 })
  } catch (e) {
    err = e
  }
  const e = err as ModelFetchError
  check('stall: every url tried, error names both reasons in order',
    e instanceof ModelFetchError && e.attempts.length === 2 && e.attempts[0].failure.kind === 'stall' && e.attempts[1].failure.kind === 'http',
    JSON.stringify(e?.attempts))
  check('stall: gave up within the watchdog window, not the hard timeout', Date.now() - t0 < 1_000 && calls.length === 2)
  check('stall: the copy tells the viewer to retry', e.message.includes('taking too long'))
}

// ---- 6. Silence before the headers: also a stall ----
{
  const { impl } = mockFetch({ 'a://1': { hangHeaders: true } })
  let err: unknown
  try {
    await fetchModelBlob(['a://1'], { fetchImpl: impl, stallMs: 50 })
  } catch (e) {
    err = e
  }
  check('no headers within the window is a stall', (err as ModelFetchError)?.attempts?.[0]?.failure.kind === 'stall')
}

// ---- 7. Bytes then silence: the watchdog resets per chunk, then fires ----
{
  const parts = split(body, 4)
  const { impl } = mockFetch({ 'a://1': { chunks: parts.slice(0, 2), gapMs: 10, hangAfterBody: true } })
  let err: unknown
  try {
    await fetchModelBlob(['a://1'], { fetchImpl: impl, stallMs: 80 })
  } catch (e) {
    err = e
  }
  check('mid-body silence is a stall', (err as ModelFetchError)?.attempts?.[0]?.failure.kind === 'stall')
}

// ---- 8. A slow drip that never stalls still hits the hard timeout ----
{
  const { impl } = mockFetch({ 'a://1': { chunks: split(body, 40), gapMs: 10 } })
  let err: unknown
  try {
    await fetchModelBlob(['a://1'], { fetchImpl: impl, stallMs: 500, timeoutMs: 60 })
  } catch (e) {
    err = e
  }
  check('hard timeout bounds a drip the watchdog would tolerate', (err as ModelFetchError)?.attempts?.[0]?.failure.kind === 'timeout')
}

// ---- 9. Oversized by header, oversized by body ----
{
  const { impl, cancelled } = mockFetch({ 'a://1': { chunks: [body], contentLength: MODEL_FETCH_MAX_BYTES + 1 } })
  let err: unknown
  try {
    await fetchModelBlob(['a://1'], { fetchImpl: impl })
  } catch (e) {
    err = e
  }
  const f = (err as ModelFetchError)?.attempts?.[0]?.failure
  check('declared size over the cap is refused before any byte', f?.kind === 'too-large' && cancelled.includes('a://1'))
  check('too-large copy names the size', (err as Error).message.includes('too large'))
}
{
  const { impl } = mockFetch({ 'a://1': { chunks: split(body, 4), contentLength: 'none' } })
  let err: unknown
  try {
    await fetchModelBlob(['a://1'], { fetchImpl: impl, maxBytes: 6_000 })
  } catch (e) {
    err = e
  }
  check('undeclared body over the cap is refused mid-stream', (err as ModelFetchError)?.attempts?.[0]?.failure.kind === 'too-large')
}

// ---- 10. The caller's abort stops everything, tries nothing further ----
{
  const { impl, calls, cancelled } = mockFetch({ 'a://1': { chunks: split(body, 10), gapMs: 15 }, 'a://2': { chunks: [body] } })
  const controller = new AbortController()
  const p = fetchModelBlob(['a://1', 'a://2'], { fetchImpl: impl, signal: controller.signal })
  await sleep(40)
  controller.abort()
  let err: unknown
  try {
    await p
  } catch (e) {
    err = e
  }
  check('cancel mid-download throws an AbortError', isAbortError(err), String(err))
  check('cancel does not walk to the next url', calls.length === 1)
  check('cancel releases the body', cancelled.includes('a://1'))
}
{
  const { impl, calls } = mockFetch({ 'a://1': { chunks: [body] } })
  const controller = new AbortController()
  controller.abort()
  let err: unknown
  try {
    await fetchModelBlob(['a://1'], { fetchImpl: impl, signal: controller.signal })
  } catch (e) {
    err = e
  }
  check('an already-aborted signal throws before any fetch', isAbortError(err) && calls.length === 0)
}

// ---- 11. Everything fails: the error carries the whole walk ----
{
  const { impl } = mockFetch({ 'a://1': { status: 404 }, 'a://2': { status: 500 }, 'a://3': { chunks: [new TextEncoder().encode('nope')] } })
  let err: unknown
  try {
    await fetchModelBlob(['a://1', 'a://2', 'a://3'], { fetchImpl: impl })
  } catch (e) {
    err = e
  }
  const e = err as ModelFetchError
  check('all urls failing throws with one entry per url',
    e instanceof ModelFetchError && e.attempts.map((a) => a.failure.kind).join(',') === 'http,http,not-glb')
  check('generic failure copy when nothing stalled', e.message === 'This 3D model could not be loaded.')
}

// ---- 12. The copy and the readout ----
check('describe: too-large wins over a stall elsewhere in the walk',
  describeModelFetchFailure([
    { url: 'a', failure: { kind: 'stall' } },
    { url: 'b', failure: { kind: 'too-large', bytes: 70 * 1024 * 1024 } },
  ]).startsWith('This 3D model is too large'))
check('readout: connecting before headers', modelLoadReadout(null, false) === 'connecting')
check('readout: preparing while model-viewer parses', modelLoadReadout({ loaded: 5, total: 5, attempt: 0 }, true) === 'preparing')
check('readout: percentage plus bytes when the total is known',
  modelLoadReadout({ loaded: 4 * 1024 * 1024, total: 28 * 1024 * 1024, attempt: 0 }, false) === '14% · 4.0 MB of 28.0 MB')
check('readout: bytes only when the total is unknown — never a fake percentage',
  modelLoadReadout({ loaded: 4 * 1024 * 1024, total: null, attempt: 0 }, false) === '4.0 MB')
check('readout: never past 100% on a lying Content-Length',
  modelLoadReadout({ loaded: 200, total: 100, attempt: 0 }, false).startsWith('100%'))
check('isAbortError: recognises DOMException and plain objects, rejects others',
  isAbortError(new DOMException('x', 'AbortError')) && isAbortError({ name: 'AbortError' }) && !isAbortError(new Error('x')) && !isAbortError(null))

// ---- 13. The walk always has somewhere to go ----
// Under Node there is no window, so the context rule picks the top-level
// (direct-first) order; the proxy must still be appended as the last URL.
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
check('walk: direct gateway first, proxy guaranteed last on a top-level page',
  eq(modelFetchUrls('ar://abc'), ['https://arweave.net/abc', '/api/img?u=ar%3A%2F%2Fabc']),
  JSON.stringify(modelFetchUrls('ar://abc')))
check('walk: proxy-first contexts keep the proxy first and never duplicate it',
  eq(modelFetchUrls('ar://abc', true), ['/api/img?u=ar%3A%2F%2Fabc', 'https://arweave.net/abc']),
  JSON.stringify(modelFetchUrls('ar://abc', true)))
check('walk: ipfs walks its pool then the proxy',
  eq(modelFetchUrls('ipfs://cid'), ['https://ipfs.io/ipfs/cid', 'https://dweb.link/ipfs/cid', '/api/img?u=ipfs%3A%2F%2Fcid']))
check('walk: a plain https model has exactly one route (the proxy is gateway-only)',
  eq(modelFetchUrls('https://example.com/m.glb'), ['https://example.com/m.glb']))

console.log(failures === 0 ? '\nverify-model-fetch: all checks passed' : `\nverify-model-fetch: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
