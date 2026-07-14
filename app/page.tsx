import { headers } from 'next/headers'
import type { Metadata } from 'next'
import { DiscoverPage } from '@/components/DiscoverPage'
import type { InitialFeatured } from '@/components/FeaturedFeed'
import { isMobileUA } from '@/lib/serverDevice'
import { JsonLd } from '@/components/JsonLd'
import { homeJsonLd } from '@/lib/structuredData'
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

// Homepage-specific metadata. Overrides the layout's generic title/description
// with keyword-informed copy for the apex URL. Only these keys are replaced —
// the layout's `other` (Farcaster embed + base:app_id verification) and
// metadataBase are inherited via Next's shallow metadata merge, so the Mini App
// card and Base domain verification are untouched.
export const metadata: Metadata = {
  title: 'Kismet — Discover, Collect & Mint Onchain Art on Base',
  description:
    'Kismet is an onchain art platform and marketplace on Base. Discover digital art, collect and trade moments, and mint your own artwork onchain.',
  alternates: { canonical: SITE_URL },
  openGraph: {
    title: 'Kismet — Onchain Art on Base',
    description:
      'Discover, collect, and mint onchain art on Kismet, an art marketplace on the Base network.',
    url: SITE_URL,
  },
}

// Server component. Detects mobile via request UA on the server and
// bakes the decision into the SSR HTML (and the prop the client
// hydrates with) so there's never a frame on desktop where the
// mobile tree exists. See lib/serverDevice.ts for the detection.
export default async function Page() {
  const [isMobile, initialFeatured] = await Promise.all([isMobileUA(), fetchInitialFeatured()])
  return (
    <>
      {/* Organization + WebSite structured data, server-rendered into the
          initial HTML so crawlers see the brand entity on first fetch. */}
      <JsonLd data={homeJsonLd()} />
      {/* The homepage's single H1 — server-rendered for a clear heading signal
          without imposing a hero on the full-bleed feed UI. sr-only keeps it
          accessible to crawlers and screen readers; the feed is the visual. */}
      <h1 className="sr-only">
        Kismet — discover, collect, and mint onchain art on Base
      </h1>
      <DiscoverPage isMobile={isMobile} initialFeatured={initialFeatured} />
    </>
  )
}
