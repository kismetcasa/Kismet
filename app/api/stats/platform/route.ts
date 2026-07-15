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
//   sales    — paid primary-market activity ON KISMET-TRACKED COLLECTIONS,
//              from the platform roll-up the hourly stats rebuild snapshots
//              off the In•Process /transfers feed (lib/stats.ts): editions
//              sold, sale transactions, unique paying collectors, artists
//              with ≥1 sale. The feed itself is network-wide; rows from
//              other In•Process apps are excluded and surfaced in
//              coverage.outOfScope (fail-closed: unplaceable rows land in
//              coverage.scopeUnknown, never in the totals).
//   passes   — Patron/Mint-Pass activity, split out of the art figures:
//              paid pass sales (sold/transactions/value) vs editions
//              airdropped as INVITES (Kismet's own airdrop records).
//   earnings — gross primary ART sale volume by currency (passes excluded —
//              see the passes block) plus Kismet-listing secondary
//              royalties; USD derived at read time from the same Chainlink
//              ETH/USD price the artist cards use, with the same honesty
//              rule (usd = 0 when the price is unavailable and the figure
//              has an ETH leg, never a silently-USDC-only number).
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
  // byte-identical to the public payload (no oracle).
  //
  // Cross-user isolation rests on TWO things, since admin and non-admin
  // ?funnel=1 share ONE url = one shared-cache key: (1) the admin variant sets
  // `private, no-store` (a compliant shared cache won't store it), and (2)
  // `Vary: Cookie` below tells any cache the response depends on the session
  // cookie, so a public body cached under ?funnel=1 can't be served to the
  // admin (or vice versa). Body content and Cache-Control are gated on the SAME
  // `funnel` truthiness, so funnel bytes can never ride a cacheable header.
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
            // Total includes hidden work; the `visible*` fields break out the
            // public-facing counts so both readings are explicit. Passes
            // excluded. visibleArtworks = artworksMinted − hiddenArtworks;
            // visibleArtists excludes makers whose every piece is hidden
            // (artistsMinted − visibleArtists = hidden-only makers).
            //
            // Every field a snapshot gained AFTER first ship (`hidden`,
            // `visibleArtists`) is null-guarded: during a deploy window the
            // stored snapshot predates them, so `catalog.hidden` is undefined
            // — ungarded, `artworks - undefined` is NaN (serialized as null,
            // silently) and `hiddenArtworks` would drop from the payload. Emit
            // an explicit null instead until the next census writes the fields.
            artworksMinted: catalog.artworks,
            hiddenArtworks: typeof catalog.hidden === 'number' ? catalog.hidden : null,
            visibleArtworks:
              typeof catalog.hidden === 'number' ? catalog.artworks - catalog.hidden : null,
            artistsMinted: catalog.artists,
            visibleArtists: catalog.visibleArtists ?? null,
            collections: catalog.collections,
            coverage: {
              possiblyTruncated: catalog.possiblyTruncated ?? null,
              pageFailures: catalog.pageFailures ?? null,
              unattributed: catalog.unattributed ?? null,
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
              outOfScope: sales.outOfScope,
              scopeUnknown: sales.scopeUnknown,
            },
            updatedAt: sales.updatedAt,
          }
        : null,
      // Patron/Mint-Pass activity, deliberately outside the art figures:
      // `sold` is paid pass editions (from the same scoped transfers scan),
      // `invited` is editions airdropped as invites (Kismet airdrop records).
      // Null until the first post-deploy scan writes the extended snapshot.
      passes:
        sales?.passes != null
          ? {
              sold: sales.passes.editions,
              transactions: sales.passes.transactions,
              invited: sales.passes.invited,
              eth: sales.passes.eth,
              usdc: sales.passes.usdc,
              usd: usdOf(sales.passes.eth, sales.passes.usdc),
            }
          : null,
      earnings,
      ...(funnel ? { funnel } : {}),
    },
    // Aggregates identical for every viewer and refreshed hourly — safe for a
    // short shared-cache window (same policy shape as the public timeline).
    // The admin funnel variant is viewer-dependent and must never be shared.
    // Vary: Cookie so a cache keys public vs admin (?funnel=1) bodies by
    // session — the second half of the cross-user guarantee alongside no-store.
    {
      headers: {
        'Cache-Control': funnel
          ? 'private, no-store'
          : 'public, s-maxage=300, stale-while-revalidate=600',
        Vary: 'Cookie',
      },
    },
  )
}
