import { MarketView } from '@/components/MarketView'
import { isMobileUA } from '@/lib/serverDevice'
import { SITE_URL } from '@/lib/siteUrl'

// Own metadata: without it this page inherited the layout's generic "Kismet"
// title — the marketplace surface deserves its own title/description in
// SERPs, plus a canonical like the other static routes.
export const metadata = {
  title: 'market — Kismet',
  description:
    'Buy and sell onchain art on the Kismet market — moments listed by collectors and artists, settled on Base in ETH or USDC.',
  alternates: { canonical: `${SITE_URL}/market` },
}

// Market is a top-level destination in the nav (alongside Enjoy and
// Mint), not a sub-tab of the discover page. Keeps the discover page's
// horizontal tab strip from overflowing on mobile / Mini App and gives
// listings a stable URL for sharing.
//
// Server component so we can detect mobile via the request UA and
// thread `isMobile` into MarketView → PaginatedGrid → LazyMount path.
// Desktop UA → isMobile=false → PaginatedGrid renders eagerly, same
// as before.
export default async function MarketPage() {
  const isMobile = await isMobileUA()
  return <MarketView isMobile={isMobile} />
}
