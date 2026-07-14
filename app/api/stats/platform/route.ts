import { NextRequest, NextResponse } from 'next/server'
import { getPlatformSalesSnapshot, getRoyaltyTotals } from '@/lib/stats'
import { getCatalogCensus } from '@/lib/catalogCensus'
import { getFunnelCounts } from '@/lib/funnelServer'
import { getEthUsd } from '@/lib/ethPrice'
import { verifyAdminSession } from '@/lib/curator'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Platform-wide marketplace analytics — the aggregate companion to the
// per-artist /api/stats read:
//
//   catalog  — artworks minted + distinct artists, from the hourly catalog
//              census over every tracked collection (lib/catalogCensus.ts).
//              Counts creation, so free mints and unsold work are included.
//   sales    — paid primary-market activity, from the platform roll-up the
//              hourly stats rebuild snapshots off the In•Process /transfers
//              feed (lib/stats.ts): editions sold, sale transactions, unique
//              paying collectors, artists with ≥1 sale.
//   earnings — gross primary sale volume by currency plus Kismet-listing
//              secondary royalties; USD derived at read time from the same
//              Chainlink ETH/USD price the artist cards use, with the same
//              honesty rule (usd = 0 when the price is unavailable and the
//              figure has an ETH leg, never a silently-USDC-only number).
//   funnel   — last-14-days conversion counters (admin session + ?funnel=1
//              only; see the gating comment in the handler).
//
// PUBLIC on purpose, unlike per-artist earnings (private by default): these
// are platform aggregates that expose no individual's figures — the same
// totals anyone could derive from the public feed and the chain. Sections are
// null before their first successful computation (deploy + run the sync-stats
// cron) rather than fabricated zeros, and each carries its coverage counters
// so a consumer can see how solid the numbers are (e.g. a high buyerMissing
// means `collectors` undercounts). Snapshots refresh hourly; the short edge
// cache below only smooths bursts.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`stats-platform:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  // Funnel block (conversion counters — lib/funnelServer.ts): ADMIN-ONLY and
  // opt-in via ?funnel=1. Unlike the aggregates below (derivable from public
  // feeds + chain), drop-off ratios are internal product data. The query flag
  // keeps the plain URL's shared-cache behavior untouched and the hot public
  // path free of session reads; a non-admin ?funnel=1 response stays
  // byte-identical to the public payload (no oracle), while the admin variant
  // is no-store and lives at a distinct cache key, so a cached public body
  // can never mask it (and it can never enter a shared cache).
  const wantsFunnel = new URL(req.url).searchParams.get('funnel') === '1'
  let funnel: Awaited<ReturnType<typeof getFunnelCounts>> = null
  if (wantsFunnel) {
    const admin = await verifyAdminSession()
    if (!('error' in admin)) funnel = await getFunnelCounts()
  }

  const [sales, catalog, royalties, ethUsd] = await Promise.all([
    getPlatformSalesSnapshot(),
    getCatalogCensus(),
    getRoyaltyTotals(),
    getEthUsd(),
  ])

  // Same rule as getArtistEarnings: never emit a partial USD figure.
  const usdOf = (eth: number, usdc: number) =>
    ethUsd == null && eth > 0 ? 0 : eth * (ethUsd ?? 0) + usdc

  // earnings is null exactly when sales is (both come from the rebuild's
  // snapshot); royalties accrue separately but only ever postdate sales.
  const earnings = sales
    ? {
        // Gross paid volume on primary mints (what buyers paid, before splits).
        primary: {
          eth: sales.eth,
          usdc: sales.usdc,
          usd: usdOf(sales.eth, sales.usdc),
        },
        // Creator royalties on resales filled through Kismet's own listings.
        // Off-platform resales pay on-chain but are structurally invisible
        // here (see lib/stats.ts ROYALTY_* scope limit).
        secondary: {
          eth: royalties.eth,
          usdc: royalties.usdc,
          usd: usdOf(royalties.eth, royalties.usdc),
        },
        total: {
          eth: sales.eth + royalties.eth,
          usdc: sales.usdc + royalties.usdc,
          usd: usdOf(sales.eth + royalties.eth, sales.usdc + royalties.usdc),
        },
        // The price the usd figures were derived with (null = unavailable,
        // usd fields are then 0 for eth-bearing figures — see usdOf).
        ethUsd,
      }
    : null

  return NextResponse.json(
    {
      catalog: catalog
        ? {
            artworksMinted: catalog.artworks,
            artistsMinted: catalog.artists,
            collections: catalog.collections,
            coverage: {
              possiblyTruncated: catalog.possiblyTruncated,
              pageFailures: catalog.pageFailures,
              unattributed: catalog.unattributed,
            },
            updatedAt: catalog.updatedAt,
          }
        : null,
      sales: sales
        ? {
            editionsSold: sales.editions,
            transactions: sales.transactions,
            collectors: sales.collectors,
            artistsWithSales: sales.artists,
            coverage: {
              buyerMissing: sales.buyerMissing,
              unknownCurrency: sales.unknownCurrency,
              droppedMints: sales.droppedMints,
            },
            updatedAt: sales.updatedAt,
          }
        : null,
      earnings,
      ...(funnel ? { funnel } : {}),
    },
    // Aggregates identical for every viewer and refreshed hourly — safe for a
    // short shared-cache window (same policy shape as the public timeline).
    // The admin funnel variant is viewer-dependent and must never be shared.
    {
      headers: {
        'Cache-Control': funnel
          ? 'private, no-store'
          : 'public, s-maxage=300, stale-while-revalidate=600',
      },
    },
  )
}
