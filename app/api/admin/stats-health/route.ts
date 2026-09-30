import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { getStatsHealth, STATS_STALE_MS, type StatsPhaseHealth } from '@/lib/statsHealth'
import { getPlatformSalesSnapshot } from '@/lib/stats'
import { getCatalogCensus } from '@/lib/catalogCensus'
import { getSweepIndex } from '@/lib/sweepIndex'

export const dynamic = 'force-dynamic'

// Admin-only ops read for the hourly stats pipeline. The integrity guards abort
// and preserve the last good snapshot on an anomaly — safe, but previously
// invisible (a console.error nobody watches). This exposes each phase's
// last-success age and last error, plus the live snapshot ages, so a wedged
// rebuild is diagnosable. `healthy` is false when either phase carries an
// unresolved error OR either snapshot is staler than STATS_STALE_MS (≥2 missed
// hourly runs). Point an uptime monitor here (carrying the admin cookie) to get
// alerting on top of the raw freshness the public endpoint's updatedAt already
// exposes. no-store so the viewer-specific admin read is never cached.
export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`admin-stats-health:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const [health, sales, catalog, sweep] = await Promise.all([
    getStatsHealth(),
    getPlatformSalesSnapshot(),
    getCatalogCensus(),
    getSweepIndex(),
  ])
  const now = Date.now()
  const ageOf = (t?: number | null) => (typeof t === 'number' ? now - t : null)
  const phase = (h: StatsPhaseHealth | null) => ({
    lastRunAt: h?.lastRunAt ?? null,
    lastOkAt: h?.lastOkAt ?? null,
    ageSinceOkMs: ageOf(h?.lastOkAt),
    lastError: h?.lastError ?? null,
    lastErrorAt: h?.lastErrorAt ?? null,
  })

  const salesAge = ageOf(sales?.updatedAt)
  const catalogAge = ageOf(catalog?.updatedAt)
  const sweepAge = ageOf(sweep?.updatedAt)
  // A null age (never written) counts as stale — no data is not "healthy".
  const isStale = (age: number | null) => age == null || age > STATS_STALE_MS
  const healthy =
    !health.rebuild?.lastError &&
    !health.census?.lastError &&
    !isStale(salesAge) &&
    !isStale(catalogAge)
  // The sweep index gets its OWN verdict rather than folding into `healthy`:
  // it is an optional, flag-gated surface, and a monitor alerting on the stats
  // pipeline must not page for a sweep-only failure (nor stay quiet about the
  // pipeline because the sweep is fine). Same rules — no unresolved error, not
  // stale, and never written counts as stale.
  const sweepHealthy = !health['sweep-index']?.lastError && !isStale(sweepAge)

  return NextResponse.json(
    {
      healthy,
      now,
      staleThresholdMs: STATS_STALE_MS,
      rebuild: phase(health.rebuild),
      census: phase(health.census),
      sweepIndex: phase(health['sweep-index']),
      sweepHealthy,
      snapshots: {
        sales: { updatedAt: sales?.updatedAt ?? null, ageMs: salesAge },
        catalog: { updatedAt: catalog?.updatedAt ?? null, ageMs: catalogAge },
        sweepIndex: {
          updatedAt: sweep?.updatedAt ?? null,
          ageMs: sweepAge,
          eligible: sweep?.eligible ?? null,
          pool: sweep?.items.length ?? null,
        },
      },
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
