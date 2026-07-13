import { headers } from 'next/headers'
import { DiscoverPage } from '@/components/DiscoverPage'
import type { InitialFeatured } from '@/components/FeaturedFeed'
import { isMobileUA } from '@/lib/serverDevice'
import { SITE_URL } from '@/lib/siteUrl'

// Bound how long the SSR render will WAIT for the featured payload without
// aborting the underlying fetch: on timeout the shell ships with the skeleton
// (the client fetch path fills in, exactly the pre-SSR behavior) while the
// fetch keeps running and lands in Next's Data Cache, warming the next
// request. An AbortSignal here would kill that warming; a long budget would
// gate landing TTFB on the upstream — this page is dynamic (isMobileUA reads
// headers()), so nothing streams and the whole HTML waits on this await.
const SSR_FEATURED_BUDGET_MS = 1_000

function withSoftTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
}

// The origin for the SSR self-fetch. SITE_URL defaults to production
// (https://kismet.art) and is NOT environment-aware — using it verbatim in
// dev bakes PRODUCTION featured data into the local SSR HTML. In development
// derive the origin from the incoming request's own Host header (trusted
// locally); everywhere else honor SITE_URL, which each deployment sets.
async function selfOrigin(): Promise<string> {
  if (process.env.NODE_ENV === 'development') {
    try {
      const h = await headers()
      const host = h.get('host')
      if (host) return `http://${host}`
    } catch {
      // fall through to SITE_URL
    }
  }
  return SITE_URL
}

// Server-fetch the featured tab's two payloads so the landing page's SSR HTML
// carries real content instead of a skeleton. Self-fetch (not a direct import
// of the route logic) so the routes' own caching/enrichment stays the single
// code path; `revalidate: 60` shares one upstream hit across requests. Every
// failure mode — soft-timeout, non-2xx, bad shape — degrades to null, where
// the client behaves exactly as it did before this existed (fetch on mount).
async function fetchInitialFeatured(): Promise<InitialFeatured | null> {
  try {
    const origin = await selfOrigin()
    const opts = { next: { revalidate: 60 } } as const
    const [tl, fc] = await withSoftTimeout(
      Promise.all([
        fetch(`${origin}/api/timeline?featured=1`, opts).then((r) => (r.ok ? r.json() : null)),
        fetch(`${origin}/api/featured/collections-hydrated`, opts).then((r) => (r.ok ? r.json() : null)),
      ]),
      SSR_FEATURED_BUDGET_MS,
    ).then((v) => v ?? [null, null])
    const moments = Array.isArray(tl?.moments) ? tl.moments : null
    if (!moments) return null
    return {
      moments,
      collections: Array.isArray(fc?.collections) ? fc.collections : [],
    }
  } catch {
    return null
  }
}

// Server component. Detects mobile via request UA on the server and
// bakes the decision into the SSR HTML (and the prop the client
// hydrates with) so there's never a frame on desktop where the
// mobile tree exists. See lib/serverDevice.ts for the detection.
export default async function Page() {
  const [isMobile, initialFeatured] = await Promise.all([isMobileUA(), fetchInitialFeatured()])
  return <DiscoverPage isMobile={isMobile} initialFeatured={initialFeatured} />
}
