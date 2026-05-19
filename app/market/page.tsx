import { MarketView } from '@/components/MarketView'
import { isMobileUA } from '@/lib/serverDevice'

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
