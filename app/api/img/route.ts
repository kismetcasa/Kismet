import { NextRequest } from 'next/server'
import sharp from 'sharp'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { readBodyBounded } from '@/lib/boundedBody'
import { fetchGatewayResolved } from '@/lib/media/gatewayFetch'
import {
  bucketWidth,
  readVariant,
  SingleFlight,
  VARIANT_CACHE_DIR,
  variantFileName,
  writeVariant,
} from '@/lib/media/imgVariantCache'
import { LRUCache } from '@/lib/lruCache'
import { redis } from '@/lib/redis'
import { bestEffort } from '@/lib/bestEffort'
import {
  countWithWindow,
  parseRangeHeader,
  planSyntheticRange,
  skipCapStream,
} from '@/lib/media/rangeContract'

// Pinned to Node's runtime: this proxy streams multi-MB media payloads
// end-to-end and we want Node's stream primitives plus unbounded request
// lifetimes.
export const runtime = 'nodejs'

// Bumped from 500MB so 1080p long-form videos (commonly 800MB–1.5GB at
// the source bitrates this site sees) pass through instead of being
// rejected. The cap exists to bound a single request's memory + egress
// footprint, not to gate "acceptable" content.
const MAX_DECLARED_BYTES = 2 * 1024 * 1024 * 1024
const RACE_TIMEOUT_MS = 30_000

// Upper clamp for the ?w= downscale width (MomentImage asks for 2048). Bounds
// what a caller can request; the clamped value then snaps UP to a cache bucket
// (imgVariantCache.bucketWidth) so arbitrary ?w= values share disk variants
// instead of fragmenting them. The optimizer-fallback path is the only
// producer and always sends 2048, which buckets to itself.
const MAX_RESIZE_WIDTH = 4096
// Only buffer-and-resize sources up to this size — a resize must hold the whole
// source in RAM, so cap it to bound this route's memory. Comfortably above any
// real still-image scan; a multi-hundred-MB "image" is pathological and streams
// through untouched rather than risking an OOM.
const MAX_RESIZE_SOURCE_BYTES = 100 * 1024 * 1024
// Wall-clock bound on one coalesced fetch+resize compute (see
// computeResizedVariant): race-to-headers (≤RACE_TIMEOUT_MS) + full source
// download (≤MAX_RESIZE_SOURCE_BYTES) + sharp. Generous because the output is
// cached forever, so finishing slow beats failing; on fire the waiters get a
// no-store 502 and the next request retries fresh.
const RESIZE_COMPUTE_BUDGET_MS = 60_000

// Throttle for the range-synthesis warning below: <video> playback through a
// degraded upstream issues many ranged requests per view, and one line a
// minute is signal while one per chunk is noise (same pattern as the
// timeline fan-out warning).
let lastSynthWarnAt = 0

// URI → exact byte size. AVFoundation refuses a synthesized 206 whose
// Content-Range total is `*` (validated in production: iOS kept rejecting
// playback until totals were real) — it needs the actual size to plan its
// range schedule. Content-addressed bytes never change, so a total learned
// once — from a Content-Length, a 206's Content-Range, a completed
// passthrough, or the count-through below — is true forever; the LRU only
// bounds memory.
const totalBytesCache = new LRUCache<string, number>(2048)
// Redis mirror of the totals cache. The in-memory LRU dies on every deploy
// and is per-replica, so each restart re-paid the count-through's full-file
// read for every video's first ranged request — count time scales with file
// size, which surfaced in the field as "small videos start fast, big ones
// take much longer" right after deploys. Totals are immutable (content-
// addressed), so persist them: read-through only on the exact path that
// would otherwise COUNT (one ~tens-of-ms REST call in place of a
// seconds-long read), write-behind whenever a total is learned. Redis
// failure degrades to today's behavior.
const TOTAL_KEY_PREFIX = 'img:total:'
// Generous TTL on the persisted totals: the value is immutable (content-
// addressed), so expiry only forces a re-learn (one count-through) on an
// asset untouched for this long — cheap self-heal — while bounding the key
// set so the mirror can't grow one key per unique asset forever. Refreshed
// on every write (learnTotal), so any asset still being viewed stays warm.
const TOTAL_TTL_SECONDS = 90 * 24 * 60 * 60

function learnTotal(u: string, total: number): void {
  if (totalBytesCache.get(u) === total) return
  totalBytesCache.set(u, total)
  void redis
    .set(TOTAL_KEY_PREFIX + u, total, { ex: TOTAL_TTL_SECONDS })
    .catch(bestEffort('img.totalPersist'))
}

async function persistedTotal(u: string): Promise<number | null> {
  try {
    const v = await redis.get(TOTAL_KEY_PREFIX + u)
    const n = Number(v)
    return v != null && Number.isSafeInteger(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

// Doomed-asset memo. Some sources die mid-body on EVERY attempt (observed
// live: a >50MB poster whose upstream edge closes the socket at ~52.4MB,
// exactly reproducibly) — and the buffering paths (resize, count-through)
// pay the full read each time a feed card scrolls past. Remember mid-read
// failures briefly and answer 502 immediately so a broken asset costs one
// doomed read per minute, not one per viewer-scroll. Short TTL: a healed
// upstream self-recovers within a minute; nothing is ever poisoned durably
// (the 502s are no-store).
const failedReadMemo = new LRUCache<string, number>(256)
const FAILED_READ_TTL_MS = 60_000
// Count-through gate: only buffer request windows up to this size (iOS
// probes are 2 bytes; generous headroom for players probing larger heads
// or moov tails via suffix ranges).
const COUNT_WINDOW_MAX_BYTES = 8 * 1024 * 1024
// Wall-clock budget for one count-through read. The count streams the whole
// file through the box once (then it's cached + the gateway edge is warm),
// so this bounds worst-case latency on the FIRST ranged request for a big
// file on a degraded upstream; on exceed we fall back to the best-effort
// `*` answer.
const COUNT_BUDGET_MS = 12_000

/** Authoritative total from a response, when it reveals one. */
function totalFromResponse(upstream: Response, declaredLen: string | null): number | null {
  if (upstream.status === 206) {
    const m = /\/(\d+)\s*$/.exec(upstream.headers.get('content-range') ?? '')
    if (m) {
      const n = Number(m[1])
      if (Number.isSafeInteger(n) && n >= 0) return n
    }
    return null
  }
  if (upstream.status === 200 && declaredLen) {
    const n = Number(declaredLen)
    if (Number.isSafeInteger(n) && n >= 0) return n
  }
  return null
}

/**
 * Stream `prefix` chunks, then everything remaining on `reader`, erroring the
 * response and cancelling the upstream once `maxBytes` total have passed —
 * MAX_DECLARED_BYTES enforced on real bytes, not the header's claim. Memory
 * stays flat: chunks flow through under client backpressure, never accumulate.
 */
function passthroughStream(
  prefix: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  // Fires with the total bytes streamed when the body completes cleanly —
  // the opportunistic totals harvest (see totalBytesCache): any full 200
  // that finishes teaches us the file's exact size for later range math.
  onDone?: (totalBytes: number) => void,
  // Fires when the UPSTREAM body dies mid-stream (socket closed, terminated).
  // Streaming paths can't switch to a 502 after headers are sent, but they
  // can arm the doomed-asset memo so the NEXT request fails fast instead of
  // re-paying a multi-MB read — the observed >50MB-poster storm came through
  // here, not the buffered paths.
  onStreamError?: (consumedBytes: number) => void,
): ReadableStream<Uint8Array> {
  let sent = 0
  let i = 0
  const guard = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    sent += chunk.byteLength
    if (sent > maxBytes) {
      controller.error(new Error('response exceeded size cap'))
      void reader.cancel().catch(() => {})
      return
    }
    controller.enqueue(chunk)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < prefix.length) {
        const chunk = prefix[i]
        // Release the slot as soon as the chunk is handed to the stream —
        // otherwise the closure pins the whole replay buffer (up to the
        // resize cap, ~100MB) for the entire remaining download instead of
        // one chunk at a time. A few dozen concurrent overflow streams
        // holding full buffers is the OOM class this route exists to avoid.
        prefix[i] = undefined as unknown as Uint8Array
        i++
        guard(controller, chunk)
        return
      }
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await reader.read()
      } catch (err) {
        onStreamError?.(sent)
        controller.error(err)
        return
      }
      const { done, value } = step
      if (done) {
        controller.close()
        onDone?.(sent)
        return
      }
      guard(controller, value)
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {})
    },
  })
}

async function raceFetchGateways(
  uri: string,
  timeoutMs: number,
  clientSignal: AbortSignal,
  forwardHeaders: HeadersInit | undefined,
): Promise<Response | null> {
  const urls = gatewayUrls(uri)
  const controllers = urls.map(() => new AbortController())
  const cancelAll = () => controllers.forEach((c) => c.abort())
  const timer = setTimeout(cancelAll, timeoutMs)
  clientSignal.addEventListener('abort', cancelAll, { once: true })
  try {
    const probes = urls.map((u, idx) =>
      fetchGatewayResolved(u, forwardHeaders, controllers[idx].signal).then((r) => ({
        response: r,
        idx,
      })),
    )
    const winner = await Promise.any(probes)
    controllers.forEach((c, i) => { if (i !== winner.idx) c.abort() })
    return winner.response
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

type ResizeOutcome =
  | { kind: 'webp'; buffer: Buffer }
  // sharp refused the buffered bytes (mislabeled gif/svg, undecodable) —
  // serve them unchanged. Never disk-cached: only verified webp output
  // earns a cache slot.
  | { kind: 'original'; buffer: Buffer; contentType: string }
  | { kind: 'too-large' }
  | { kind: 'unavailable' }
  // Source belongs to the streaming path (video/gif/svg content-type,
  // declared or actual size past the resize cap) — caller falls through.
  | { kind: 'stream-class' }

// Coalesces concurrent computes per (uri, width): drop-time armor for the
// featured mint pass, whose cold burst used to trigger one full source
// download + sharp job PER VIEWER.
const resizeFlight = new SingleFlight<ResizeOutcome>()

/**
 * Fetch + buffer + resize one ?w= variant. Runs behind resizeFlight and a
 * disk-cache miss (see GET), DETACHED from every client's abort signal: the
 * output is immutable and disk-cached, so once a download starts we want it
 * to finish and land in the cache even if the triggering viewer scrolled
 * away — otherwise the next viewer restarts the same multi-MB read. The
 * budget bounds how long a hung upstream can pin the single-flight slot.
 */
async function computeResizedVariant(u: string, width: number): Promise<ResizeOutcome> {
  const budget = AbortSignal.timeout(RESIZE_COMPUTE_BUDGET_MS)
  const upstream = await raceFetchGateways(u, RACE_TIMEOUT_MS, budget, undefined)
  if (!upstream?.body) return { kind: 'unavailable' }
  const declaredLen = upstream.headers.get('content-length')
  if (declaredLen && Number(declaredLen) > MAX_DECLARED_BYTES) {
    void upstream.body.cancel().catch(() => {})
    return { kind: 'too-large' }
  }
  const ct = (upstream.headers.get('content-type') ?? '').toLowerCase()
  const resizable =
    !ct.startsWith('video/') &&
    !ct.startsWith('image/gif') &&
    !ct.startsWith('image/svg') &&
    (!declaredLen || Number(declaredLen) <= MAX_RESIZE_SOURCE_BYTES)
  if (!resizable) {
    // Costs one headers-only fetch (body cancelled) before the streaming
    // path re-fetches — only mislabeled sources pay it: the client never
    // sends ?w= for a known GIF, and video rides the no-w proxy URL.
    void upstream.body.cancel().catch(() => {})
    return { kind: 'stream-class' }
  }
  let read: Awaited<ReturnType<typeof readBodyBounded>>
  try {
    read = await readBodyBounded(upstream.body, MAX_RESIZE_SOURCE_BYTES)
  } catch (err) {
    // Same doomed-asset memo as the pre-coalesce code: a source that dies
    // mid-read will die again. Arm only on a genuine upstream death — not
    // when our own budget fired (client aborts can't reach this signal).
    if (!budget.aborted) failedReadMemo.set(u, Date.now())
    throw err
  }
  if (read.kind === 'overflow') {
    // Body outgrew the resize buffer despite a small/absent declared length.
    // The pre-coalesce code spliced the read-so-far into a passthrough for
    // its one requester; a shared compute has no single requester to hand a
    // live stream to, so surrender the bytes and let each waiter stream
    // fresh (the gateway edge is warm now). Pathological by definition — a
    // >100MB "image" — so the extra read is acceptable.
    void read.reader.cancel().catch(() => {})
    return { kind: 'stream-class' }
  }
  const original = read.buffer
  // Totals harvest (same doctrine as the streaming paths below): a complete
  // rangeless 200 read IS the whole file — teach the range-synthesis cache.
  if (upstream.status === 200) learnTotal(u, original.length)
  try {
    const resized = await sharp(original, { failOn: 'none' })
      .rotate() // honour EXIF orientation (phone/scanner captures)
      .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer()
    // Write-behind: never blocks the response. The variant is immutable, so
    // a lost write only means one more cold compute later.
    void writeVariant(VARIANT_CACHE_DIR, variantFileName(u, width), resized)
    return { kind: 'webp', buffer: resized }
  } catch {
    return {
      kind: 'original',
      buffer: original,
      contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
    }
  }
}

function webpResponse(buf: Buffer): Response {
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(buf.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}

/**
 * Passthrough proxy for ar:// + ipfs:// content. Races the gateway pool
 * server-side and streams the winner back with an immutable 1-year cache
 * header so downstream caches (browser, reverse proxy, optional CDN)
 * serve repeats without re-racing the pool. Used by MomentImage's
 * 'proxy' delivery mode and by long-form <video> elements that need
 * range-request support for seeking and resume.
 */
export async function GET(req: NextRequest) {
  // No per-IP request-count rate limit here, deliberately: <video> in the
  // Mini App + Safari path (see videoGatewayUrls in lib/media/gateway.ts)
  // streams through this proxy via Range requests — many per playthrough —
  // and that audience is largely mobile behind carrier-grade NAT, so a
  // count-based per-IP cap would 429 legitimate viewers (collateral across a
  // shared IP) while barely bounding the real resource (egress bytes, not
  // request count). The controls that fit a streaming media proxy are the
  // per-request MAX_DECLARED_BYTES cap below and a CDN in front
  // (see REMEDIATION_PLAYBOOK.md §B5 for the verdict, CDN_RUNBOOK.md for the
  // reproducible Cloudflare config + verification).
  const u = req.nextUrl.searchParams.get('u')
  if (!u) return new Response('missing u', { status: 400 })
  // SSRF: proxy our gateway pool only, never arbitrary outbound.
  if (!u.startsWith('ar://') && !u.startsWith('ipfs://')) {
    return new Response('only ar:// and ipfs:// supported', { status: 400 })
  }
  // Forward Range so long-form <video> elements can seek and resume
  // without re-downloading from byte 0. Browsers issue Range requests
  // automatically once they see Accept-Ranges on the initial response;
  // without this pass-through the proxy was effectively forcing
  // progressive-only playback even when the upstream gateway supported
  // ranges natively.
  const range = req.headers.get('range')

  // ?w= downscale request — the NextImage optimizer→proxy fallback (and any
  // preferProxy caller). Parsed before everything else because a disk-cached
  // variant answers with ZERO upstream work — even for assets currently
  // memo'd as doomed (the bytes are already local; upstream health is
  // irrelevant to serving them).
  const wParam = req.nextUrl.searchParams.get('w')
  const resizeWidth = wParam
    ? bucketWidth(Math.min(MAX_RESIZE_WIDTH, Math.max(1, Math.trunc(Number(wParam)) || 0)))
    : 0
  const wantsResize = resizeWidth > 0 && !range
  if (wantsResize) {
    const cached = await readVariant(VARIANT_CACHE_DIR, variantFileName(u, resizeWidth))
    if (cached) return webpResponse(cached)
  }

  // Doomed-asset fast-fail: a source that died mid-read moments ago will
  // die again — don't re-pay a multi-MB buffered read per viewer-scroll.
  const failedAt = failedReadMemo.get(u)
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_READ_TTL_MS) {
    return new Response('upstream repeatedly failing mid-read', {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  // Arm the doomed-asset memo when an upstream body dies mid-stream on any
  // delivery path. Client aborts (viewer scrolled away) don't count — only
  // genuine upstream deaths.
  const onUpstreamStreamError = () => {
    if (!req.signal.aborted) failedReadMemo.set(u, Date.now())
  }
  // Server-side downscale for the NextImage optimizer→proxy fallback (?w=). A
  // source too large for the next/image optimizer (it 413s) would otherwise
  // stream here at full resolution — fine on desktop's private pool, but it
  // stalls mobile + the miniapp's shared, constrained HTTP/2 pool. Resize it to
  // a small WebP so every surface gets light bytes. Still rasters only, on a
  // non-range request; GIF (animation), SVG (vector), and video fall through to
  // the streaming path untouched, and any sharp failure serves the original
  // bytes. Disk miss ⇒ ONE coalesced fetch+resize shared by every concurrent
  // request for the variant (computeResizedVariant), whose webp lands in the
  // persisted .next/cache volume — so each variant is fetched from the gateway
  // and resized at most once EVER (across restarts and deploys), not once per
  // viewer. That recompute-per-request was why the featured Patron mint pass
  // paid a multi-second first paint while optimizer-eligible cards beside it
  // served from next/image's own disk cache.
  if (wantsResize) {
    let outcome: ResizeOutcome
    try {
      outcome = await resizeFlight.run(`${u}|${resizeWidth}`, () =>
        computeResizedVariant(u, resizeWidth),
      )
    } catch {
      // Mid-read death inside the compute (memo armed there) — same answer
      // the pre-coalesce buffered read gave: fail fast, never cacheable.
      return new Response('upstream stream failed mid-read', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    if (outcome.kind === 'webp') return webpResponse(outcome.buffer)
    if (outcome.kind === 'original') {
      return new Response(new Uint8Array(outcome.buffer), {
        status: 200,
        headers: {
          'Content-Type': outcome.contentType,
          'Content-Length': String(outcome.buffer.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
    if (outcome.kind === 'too-large') {
      return new Response('too large', { status: 413, headers: { 'Cache-Control': 'no-store' } })
    }
    if (outcome.kind === 'unavailable') {
      // Don't cache outages — the bundle may propagate before the next request.
      return new Response('upstream unavailable', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    // 'stream-class': video/gif/svg or an over-cap body — fall through to the
    // streaming path below on a fresh, client-signal-bound fetch.
  }

  const forwardHeaders = range ? { range } : undefined
  const upstream = await raceFetchGateways(
    u,
    RACE_TIMEOUT_MS,
    req.signal,
    forwardHeaders,
  )
  if (!upstream?.body) {
    // Don't cache outages — the bundle may propagate before the next request.
    return new Response('upstream unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
  const declaredLen = upstream.headers.get('content-length')
  if (declaredLen && Number(declaredLen) > MAX_DECLARED_BYTES) {
    upstream.body.cancel().catch(() => {})
    return new Response('too large', { status: 413, headers: { 'Cache-Control': 'no-store' } })
  }

  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    // ar://<txid> / ipfs://<cid> are content-addressed — bytes never change.
    'Cache-Control': 'public, max-age=31536000, immutable',
  })

  // Own the byte-range contract when the upstream ignored the range. iOS +
  // macOS Safari (AVFoundation) probe every <video> with `Range: bytes=0-1`
  // and refuse to play a source that answers 200 — and the WebKit population
  // is exactly who videoGatewayUrls routes through this proxy. A degraded
  // upstream (arweave.net sandbox hosts serving chunked 200s with no
  // Accept-Ranges/Content-Length) therefore used to make videos unplayable
  // on every Apple surface while desktop Chrome played fine. Synthesize the
  // 206 ourselves: skip to the requested window in the stream and cap it.
  // Bandwidth note: skipping burns upstream bytes up to `start`, bounded by
  // MAX_DECLARED_BYTES like everything else — acceptable for the degraded
  // case, and range-capable upstreams never enter this branch (their 206
  // passes through verbatim below).
  // Harvest authoritative totals whenever a response reveals one (a 200's
  // Content-Length, a 206's Content-Range denominator) — content-addressed,
  // so once learned it's true forever.
  const headerTotal = totalFromResponse(upstream, declaredLen)
  if (headerTotal != null) learnTotal(u, headerTotal)

  if (range && upstream.status !== 206) {
    const parsed = parseRangeHeader(range)
    if (parsed) {
      let total = headerTotal ?? totalBytesCache.get(u) ?? null
      // Cold memory (fresh deploy / other replica): one Redis round trip on
      // exactly the path that would otherwise re-read the whole file.
      if (total == null) {
        const persisted = await persistedTotal(u)
        if (persisted != null) {
          totalBytesCache.set(u, persisted)
          total = persisted
        }
      }

      // Count-through: the upstream ignored the range AND told us nothing
      // about its size. Serving `bytes 0-1/*` here is spec-legal but
      // AVFoundation rejects unknown totals, so for small request windows
      // (the iOS probe class) read the body to EOF once — buffering only
      // the window — to learn the exact total, cache it, and answer with a
      // REAL Content-Range. One bounded read per URI, ever; it also warms
      // the gateway edge for the follow-up requests iOS then issues.
      if (total == null) {
        const windowSpec =
          parsed.suffix != null
            ? parsed.suffix <= COUNT_WINDOW_MAX_BYTES
              ? { suffix: parsed.suffix }
              : null
            : parsed.end != null && parsed.end - parsed.start + 1 <= COUNT_WINDOW_MAX_BYTES
              ? { start: parsed.start, end: parsed.end }
              : null
        if (windowSpec) {
          // Same mid-read failure class as the resize buffer above — the
          // count walks the whole body and an upstream that dies partway
          // must not become an unhandled 500 (or a per-viewer repeat cost).
          let counted: Awaited<ReturnType<typeof countWithWindow>>
          try {
            counted = await countWithWindow(upstream.body.getReader(), {
              window: windowSpec,
              maxBytes: MAX_DECLARED_BYTES,
              maxMs: COUNT_BUDGET_MS,
            })
          } catch {
            if (!req.signal.aborted) failedReadMemo.set(u, Date.now())
            return new Response('upstream stream failed mid-read', {
              status: 502,
              headers: { 'Cache-Control': 'no-store' },
            })
          }
          if (counted.kind === 'counted') {
            total = counted.total
            learnTotal(u, total)
            console.log('[img] counted total for rangeless upstream', { u, total })
            const plan = planSyntheticRange(parsed, total)
            if (plan.kind === 'unsatisfiable') {
              return new Response(null, {
                status: 416,
                headers: { 'Content-Range': plan.contentRange, 'Cache-Control': 'no-store' },
              })
            }
            if (plan.kind === 'serve' && counted.window.byteLength >= plan.contentLength) {
              // start-form windows begin exactly at plan.start; suffix
              // windows hold the tail, whose last contentLength bytes are
              // the requested slice. Both reduce to "take the last/first
              // contentLength bytes" — for start-form the window length
              // equals contentLength already (EOF clamps it).
              const body =
                parsed.suffix != null
                  ? counted.window.subarray(counted.window.byteLength - plan.contentLength)
                  : counted.window.subarray(0, plan.contentLength)
              headers.set('Accept-Ranges', 'bytes')
              headers.set('Content-Range', plan.contentRange)
              headers.set('Content-Length', String(plan.contentLength))
              return new Response(body as BodyInit, { status: 206, headers })
            }
            // Window shorter than the plan demands (shouldn't happen: EOF
            // clamping keeps them consistent) — fail honestly, no caching.
            return new Response('upstream window incomplete', {
              status: 502,
              headers: { 'Cache-Control': 'no-store' },
            })
          }
          // Budget exceeded before EOF. The stream is consumed, so the only
          // honest answers are a best-effort `*` (when the window is whole
          // — start-form windows fill early) or a clean failure. Logged
          // (throttled) because this is the "iOS keeps rejecting a big
          // rangeless file" signature — if it recurs for the same URI, the
          // file is too large to count within budget and needs the CDN (or
          // a range-capable gateway) rather than more retries.
          if (Date.now() - lastSynthWarnAt > 60_000) {
            lastSynthWarnAt = Date.now()
            console.warn('[img] count-through budget exceeded — total unknown', {
              u,
              range,
              consumed: counted.consumed,
            })
          }
          const expected =
            parsed.suffix == null && parsed.end != null ? parsed.end - parsed.start + 1 : null
          if (expected != null && counted.window.byteLength === expected) {
            headers.set('Accept-Ranges', 'bytes')
            headers.set('Content-Range', `bytes ${parsed.start}-${parsed.end}/*`)
            headers.set('Content-Length', String(expected))
            return new Response(counted.window as BodyInit, { status: 206, headers })
          }
          return new Response('upstream size unresolvable', {
            status: 502,
            headers: { 'Cache-Control': 'no-store' },
          })
        }
      }

      const plan = planSyntheticRange(parsed, total)
      if (plan.kind === 'unsatisfiable') {
        upstream.body.cancel().catch(() => {})
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': plan.contentRange, 'Cache-Control': 'no-store' },
        })
      }
      if (plan.kind === 'serve') {
        if (Date.now() - lastSynthWarnAt > 60_000) {
          lastSynthWarnAt = Date.now()
          console.warn('[img] upstream ignored Range — synthesizing 206', {
            u,
            range,
            total,
          })
        }
        headers.set('Accept-Ranges', 'bytes')
        headers.set('Content-Range', plan.contentRange)
        headers.set('Content-Length', String(plan.contentLength))
        return new Response(
          skipCapStream(upstream.body.getReader(), {
            skipBytes: plan.start,
            emitBytes: plan.contentLength,
            maxTotalBytes: MAX_DECLARED_BYTES,
            onStreamError: onUpstreamStreamError,
          }),
          { status: 206, headers },
        )
      }
      // 'full' (open range, unknown total): fall through to the plain 200 —
      // RFC 9110 permits ignoring a Range; a 200 is honest where a
      // malformed Content-Range would not be.
    }
  }

  if (declaredLen) headers.set('Content-Length', declaredLen)
  // Range-related headers pass through verbatim so the browser knows which
  // byte window a 206 actually contains. Accept-Ranges is always advertised:
  // even when the upstream omits it, this route now honors ranges itself
  // (206 passthrough or the synthesis above), and without the advertisement
  // AVFoundation won't attempt ranged playback at all.
  headers.set('Accept-Ranges', upstream.headers.get('accept-ranges') ?? 'bytes')
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers.set('Content-Range', contentRange)
  // Wrap the passthrough in a byte-counting guard so MAX_DECLARED_BYTES holds
  // on actual bytes even when the upstream omits or misreports Content-Length.
  // A rangeless full-body 200 that completes teaches us the exact total for
  // the totals cache (206 parts and client-ranged responses don't — their
  // byte count isn't the file size).
  const harvestTotal =
    upstream.status === 200 && !range
      ? (totalBytes: number) => learnTotal(u, totalBytes)
      : undefined
  return new Response(
    passthroughStream([], upstream.body.getReader(), MAX_DECLARED_BYTES, harvestTotal, onUpstreamStreamError),
    {
      // Preserve 206 vs 200 — flattening 206 to 200 would make the
      // browser treat the partial body as the full file.
      status: upstream.status === 206 ? 206 : 200,
      headers,
    },
  )
}
