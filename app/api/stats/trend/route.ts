import { NextRequest, NextResponse } from 'next/server'
import { getDailyStats } from '@/lib/stats'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Daily trend series for the platform-stats modal chart — the cumulative
// volume / artist / platform totals, one point per UTC day (lib/stats.ts
// recordDailyStats writes them off the hourly rebuild). Split OUT of
// /api/stats/platform on purpose: that payload is the hot public path fetched
// to populate the whole modal, and the series grows one point a day, so it's
// lazy-loaded only when the chart mounts. Native eth+usdc plus each day's
// ethUsd travel through untouched — the client windows and converts (honest-
// historical) via lib/trendMath, matching the headline it sits under.
//
// PUBLIC and cacheable like the platform aggregates: it exposes no individual's
// figures, just the same platform totals graphed over time. `[]` until the
// first recorded day (never fabricated points).
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`stats-trend:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const series = await getDailyStats()

  return NextResponse.json(
    { series },
    {
      // Same shared-cache window as /api/stats/platform: identical for every
      // viewer, refreshed at most hourly, so a short edge cache smooths bursts.
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    },
  )
}
