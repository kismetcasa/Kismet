import { NextRequest } from 'next/server'
import { gatewayUrls } from '@/lib/arweave/gateways'

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
      fetch(u, {
        cache: 'no-store',
        signal: controllers[idx].signal,
        headers: forwardHeaders,
      }).then((r) => {
        // 200 and 206 (Partial Content) are both winning states when
        // forwarding a Range header — gateways that honor ranges
        // return 206; ones that don't fall back to 200 + full body
        // and the browser will discard bytes outside the range.
        if (!r.ok && r.status !== 206) throw new Error()
        return { response: r, idx }
      }),
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
  const headers = new Headers({
    'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    // ar://<txid> / ipfs://<cid> are content-addressed — bytes never change.
    'Cache-Control': 'public, max-age=31536000, immutable',
  })
  if (declaredLen) headers.set('Content-Length', declaredLen)
  // Range-related headers pass through verbatim so the browser knows
  // (a) the resource supports ranges and (b) which byte window the
  // 206 response actually contains.
  const acceptRanges = upstream.headers.get('accept-ranges')
  if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers.set('Content-Range', contentRange)
  return new Response(upstream.body, {
    // Preserve 206 vs 200 — flattening 206 to 200 would make the
    // browser treat the partial body as the full file.
    status: upstream.status === 206 ? 206 : 200,
    headers,
  })
}
