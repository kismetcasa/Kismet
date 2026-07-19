import type { Metadata } from 'next'
import { DiscoverMarketView } from '@/components/DiscoverMarketView'
import { parseDiscoverState } from '@/components/DiscoverFilters'
import { isMobileUA } from '@/lib/serverDevice'
import { JsonLd } from '@/components/JsonLd'
import { discoverJsonLd } from '@/lib/structuredData'
import { SITE_URL } from '@/lib/siteUrl'

// Own metadata: /discover is a distinct indexable surface (the market browser),
// so it gets its own keyword-informed title/description + canonical rather than
// inheriting the layout's generic "Kismet". Reclaims the "discover" query with a
// dedicated page — the homepage keeps its own "discover, collect & mint" copy,
// and these two canonicals keep them from competing.
export const metadata: Metadata = {
  title: 'Discover — Every Mint & Resale on Kismet',
  description:
    'Browse every artwork minted and listed on Kismet in chronological order — the primary mint market and the secondary resale market, settled on Base.',
  alternates: { canonical: `${SITE_URL}/discover` },
  openGraph: {
    title: 'Discover onchain art on Kismet',
    description:
      'Every mint and every resale on Kismet, in chronological order — settled on Base in ETH or USDC.',
    url: `${SITE_URL}/discover`,
  },
}

// Server component so the request UA picks the mobile (20-per-tap) vs desktop
// (infinite-scroll) load behavior in the SSR HTML — same pattern as /market.
// The filter state lives in the querystring (shareable, back-button coherent):
// parsed here so SSR and hydration agree, then mutated client-side via
// history.replaceState — pill taps never re-run this server component.
// Filtered variants share the /discover canonical above, so they can't
// fragment the page's search identity.
export default async function DiscoverMarketPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [isMobile, params] = await Promise.all([isMobileUA(), searchParams])
  const initialState = parseDiscoverState((key) => {
    const v = params[key]
    return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null
  })
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* CollectionPage + breadcrumb structured data in the initial HTML. */}
      <JsonLd data={discoverJsonLd()} />
      {/* The page's single H1 — server-rendered for a clear heading signal;
          sr-only because the oval grid is the visual. */}
      <h1 className="sr-only">
        Discover onchain art on Kismet — every mint and resale, in chronological order
      </h1>
      <DiscoverMarketView isMobile={isMobile} initialState={initialState} />
    </div>
  )
}
