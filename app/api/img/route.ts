import { NextRequest } from 'next/server'
import sharp from 'sharp'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { readBodyBounded } from '@/lib/boundedBody'
import { fetchGatewayResolved } from '@/lib/media/gatewayFetch'
import { parseRangeHeader, planSyntheticRange, skipCapStream } from '@/lib/media/rangeContract'

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
// what a caller can request; the optimizer-fallback path is the only producer.
const MAX_RESIZE_WIDTH = 4096
// Only buffer-and-resize sources up to this size — a resize must hold the whole
// source in RAM, so cap it to bound this route's memory. Comfortably above any
// real still-image scan; a multi-hundred-MB "image" is pathological and streams
// through untouched rather than risking an OOM.
const MAX_RESIZE_SOURCE_BYTES = 100 * 1024 * 1024

// Throttle for the range-synthesis warning below: <video> playback through a
// degraded upstream issues many ranged requests per view, and one line a
// minute is signal while one per chunk is noise (same pattern as the
// timeline fan-out warning).
let lastSynthWarnAt = 0

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
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
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

  // Server-side downscale for the NextImage optimizer→proxy fallback (?w=). A
  // source too large for the next/image optimizer (it 413s) would otherwise
  // stream here at full resolution — fine on desktop's private pool, but it
  // stalls mobile + the miniapp's shared, constrained HTTP/2 pool. Resize it to
  // a small WebP so every surface gets light bytes. Still rasters only, on a
  // non-range request; GIF (animation), SVG (vector), and video pass through
  // untouched, and any sharp failure falls back to the original bytes. The
  // result is cached immutably under the distinct ?w= key (content-addressed
  // source ⇒ safe forever), so each variant is computed at most once.
  const upstreamCt = (upstream.headers.get('content-type') ?? '').toLowerCase()
  const wParam = req.nextUrl.searchParams.get('w')
  const resizeWidth = wParam
    ? Math.min(MAX_RESIZE_WIDTH, Math.max(1, Math.trunc(Number(wParam)) || 0))
    : 0
  const canResize =
    resizeWidth > 0 &&
    !range &&
    !upstreamCt.startsWith('video/') &&
    !upstreamCt.startsWith('image/gif') &&
    !upstreamCt.startsWith('image/svg') &&
    (!declaredLen || Number(declaredLen) <= MAX_RESIZE_SOURCE_BYTES)
  if (canResize) {
    const read = await readBodyBounded(upstream.body, MAX_RESIZE_SOURCE_BYTES)
    if (read.kind === 'overflow') {
      // The header claimed small (or said nothing) but the body is past the
      // resize cap — give it the exact treatment a truthfully-declared large
      // source gets: stream through untouched. The bytes already read are
      // replayed ahead of the live remainder, so nothing re-fetches.
      return new Response(passthroughStream(read.chunks, read.reader, MAX_DECLARED_BYTES), {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
    const original = read.buffer
    try {
      const resized = await sharp(original, { failOn: 'none' })
        .rotate() // honour EXIF orientation (phone/scanner captures)
        .resize({ width: resizeWidth, height: resizeWidth, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      return new Response(new Uint8Array(resized), {
        status: 200,
        headers: {
          'Content-Type': 'image/webp',
          'Content-Length': String(resized.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    } catch {
      // Mislabeled gif/svg or anything sharp can't decode — serve the bytes we
      // already buffered, unchanged, rather than failing the image.
      return new Response(new Uint8Array(original), {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
          'Content-Length': String(original.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      })
    }
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
  if (range && upstream.status !== 206) {
    const parsed = parseRangeHeader(range)
    if (parsed) {
      const total =
        declaredLen && Number.isSafeInteger(Number(declaredLen)) ? Number(declaredLen) : null
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
  return new Response(passthroughStream([], upstream.body.getReader(), MAX_DECLARED_BYTES), {
    // Preserve 206 vs 200 — flattening 206 to 200 would make the
    // browser treat the partial body as the full file.
    status: upstream.status === 206 ? 206 : 200,
    headers,
  })
}
