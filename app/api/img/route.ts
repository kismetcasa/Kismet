import { NextRequest } from 'next/server'
import { gatewayUrls } from '@/lib/arweave/gateways'

// Edge runtime caps streaming responses; node has no such cap, which matters
// for the multi-MB GIFs this proxy is built around.
export const runtime = 'nodejs'
export const maxDuration = 60

const MAX_DECLARED_BYTES = 500 * 1024 * 1024
const RACE_TIMEOUT_MS = 30_000

async function raceFetchGateways(
  uri: string,
  timeoutMs: number,
  clientSignal: AbortSignal,
): Promise<Response | null> {
  const urls = gatewayUrls(uri)
  const controllers = urls.map(() => new AbortController())
  const cancelAll = () => controllers.forEach((c) => c.abort())
  const timer = setTimeout(cancelAll, timeoutMs)
  clientSignal.addEventListener('abort', cancelAll, { once: true })
  try {
    const probes = urls.map((u, idx) =>
      fetch(u, { cache: 'no-store', signal: controllers[idx].signal }).then((r) => {
        if (!r.ok) throw new Error()
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
 * header — puts GIFs and >4MB sources behind Vercel's per-region edge cache.
 * Used by MomentImage's 'proxy' delivery mode.
 */
export async function GET(req: NextRequest) {
  const u = req.nextUrl.searchParams.get('u')
  if (!u) return new Response('missing u', { status: 400 })
  // SSRF: proxy our gateway pool only, never arbitrary outbound.
  if (!u.startsWith('ar://') && !u.startsWith('ipfs://')) {
    return new Response('only ar:// and ipfs:// supported', { status: 400 })
  }
  const upstream = await raceFetchGateways(u, RACE_TIMEOUT_MS, req.signal)
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
  return new Response(upstream.body, { status: 200, headers })
}
