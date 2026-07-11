import { DiscoverPage } from '@/components/DiscoverPage'
import type { InitialFeatured } from '@/components/FeaturedFeed'
import { isMobileUA } from '@/lib/serverDevice'
import { SITE_URL } from '@/lib/siteUrl'

// Server-fetch the featured tab's two payloads so the landing page's SSR HTML
// carries real content instead of a skeleton. Self-fetch (not a direct import
// of the route logic) so the routes' own caching/enrichment stays the single
// code path; `revalidate: 60` shares one upstream hit across requests. Every
// failure mode — timeout, non-2xx, bad shape — degrades to null, where the
// client behaves exactly as it did before this existed (fetch on mount).
async function fetchInitialFeatured(): Promise<InitialFeatured | null> {
  try {
    const opts = { next: { revalidate: 60 }, signal: AbortSignal.timeout(3_000) } as const
    const [tl, fc] = await Promise.all([
      fetch(`${SITE_URL}/api/timeline?featured=1`, opts).then((r) => (r.ok ? r.json() : null)),
      fetch(`${SITE_URL}/api/featured/collections-hydrated`, opts).then((r) => (r.ok ? r.json() : null)),
    ])
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
