import { NextRequest, NextResponse } from 'next/server'
import { getDailyStats } from '@/lib/stats'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Daily trend series for the platform-stats modal chart — cumulative
// volume/artist/platform totals, one point per UTC day (recordDailyStats writes
// them off the hourly rebuild). Split OUT of /api/stats/platform (the hot modal
// payload) and lazy-loaded when the chart mounts, since the series grows daily.
// Native eth+usdc + each day's ethUsd pass through untouched; the client windows
// and converts honest-historically via lib/trendMath. PUBLIC + cacheable like
// the other aggregates (no individual figures); [] until the first recorded day.
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
