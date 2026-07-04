// Server-side gateway fetch with MANUAL redirect resolution — the network
// half of /api/img's byte-range ownership (the pure half lives in
// rangeContract.ts). Kept outside the route file so
// scripts/verify-img-range.ts can exercise the walk against a mocked fetch
// (Next route modules may only export handlers).

// Relative .ts imports (not '@/lib/…') so scripts/verify-img-range.ts can
// load this module under plain `node --experimental-strip-types`, which
// resolves neither tsconfig path aliases nor extensionless specifiers.
import { LRUCache } from '../lruCache.ts'
import { isHtmlFallback, redirectAllowed } from './rangeContract.ts'

// Gateway URL → resolved final URL after following its redirect chain.
// arweave.net 302s data items to per-txid sandbox subdomains; resolving
// once and caching lets every subsequent request for the same item — and
// <video> playback issues MANY Range requests per view — go straight to
// the final host with the Range header applied there, instead of paying
// the redirect hop (and risking the range dying on it) every time.
// Content-addressed source ⇒ the mapping is stable; the TTL only bounds
// gateway routing changes. A stale entry self-heals: the cached-URL fetch
// failing falls through to a fresh walk that overwrites it.
const finalUrlCache = new LRUCache<string, { url: string; expiresAt: number }>(512)
const FINAL_URL_TTL_MS = 10 * 60_000
const MAX_REDIRECT_HOPS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch one gateway candidate with redirects followed MANUALLY so that
 * (a) the client's Range header is guaranteed to be applied to the FINAL
 * host — `redirect: 'follow'` left that to undici/upstream behavior, and a
 * range lost mid-chain came back as a rangeless 200 that iOS refuses (the
 * root cause in VIDEO_PLAYBACK_RCA.md) — and (b) each hop is validated by
 * redirectAllowed, pinning the walk to the gateway's own domain instead of
 * blindly following wherever a gateway points (SSRF hygiene).
 *
 * Throws on any non-winning outcome (HTTP error, hop violation, HTML
 * fallback page) so the caller's Promise.any picks a healthy sibling — an
 * HTML landing page passed through here used to get cached as the media
 * for a year.
 *
 * `fetchImpl` exists for the verify script; production callers omit it.
 */
export async function fetchGatewayResolved(
  gatewayUrl: string,
  forwardHeaders: HeadersInit | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const init = {
    cache: 'no-store' as const,
    redirect: 'manual' as const,
    signal,
    headers: forwardHeaders,
  }
  const winning = (r: Response) =>
    (r.ok || r.status === 206) && !isHtmlFallback(r.headers.get('content-type'))

  const cached = finalUrlCache.get(gatewayUrl)
  if (cached && cached.expiresAt > Date.now()) {
    try {
      const r = await fetchImpl(cached.url, init)
      if (winning(r)) return r
      // Stale/broken mapping — discard the response, fall through to a
      // fresh walk from the gateway root (which overwrites the entry).
      void r.body?.cancel().catch(() => {})
    } catch {
      // Network error on the cached final: re-walk unless the caller
      // aborted (racer timeout / client gone), where retrying is wasted.
      if (signal.aborted) throw new Error('aborted')
    }
  }

  let current = gatewayUrl
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const r = await fetchImpl(current, init)
    if (REDIRECT_STATUSES.has(r.status)) {
      const loc = r.headers.get('location')
      void r.body?.cancel().catch(() => {})
      const next = loc ? redirectAllowed(gatewayUrl, loc, current) : null
      if (!next) throw new Error(`redirect rejected from ${current}`)
      current = next.toString()
      continue
    }
    if (!winning(r)) {
      void r.body?.cancel().catch(() => {})
      throw new Error(
        isHtmlFallback(r.headers.get('content-type'))
          ? 'gateway served HTML fallback page'
          : `gateway status ${r.status}`,
      )
    }
    if (current !== gatewayUrl) {
      finalUrlCache.set(gatewayUrl, { url: current, expiresAt: Date.now() + FINAL_URL_TTL_MS })
    }
    return r
  }
  throw new Error('too many redirects')
}
