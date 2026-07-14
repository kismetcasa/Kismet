import type { Metadata } from 'next'
import { DiscoverPage } from '@/components/DiscoverPage'
import { isMobileUA } from '@/lib/serverDevice'
import { JsonLd } from '@/components/JsonLd'
import { homeJsonLd } from '@/lib/structuredData'
import { SITE_URL } from '@/lib/siteUrl'

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
  const isMobile = await isMobileUA()
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
      <DiscoverPage isMobile={isMobile} />
    </>
  )
}
