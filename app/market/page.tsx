import { MarketView } from '@/components/MarketView'

// Market is a top-level destination in the nav (alongside Enjoy and
// Mint), not a sub-tab of the discover page. Keeps the discover page's
// horizontal tab strip from overflowing on mobile / Mini App and gives
// listings a stable URL for sharing.
export default function MarketPage() {
  return <MarketView />
}
