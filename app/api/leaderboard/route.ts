import { NextRequest, NextResponse } from 'next/server'
import { getEarningsLeaderboard } from '@/lib/stats'
import type { EarningsMetric } from '@/lib/earningsFormat'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Public top-artists feed. Ranks by metric=eth|usdc|usd (default usd); each row
// carries all three figures + the mint count. Gating lives in getEarningsLeaderboard.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`leaderboard:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const { searchParams } = new URL(req.url)
  const m = searchParams.get('metric')
  const metric: EarningsMetric = m === 'eth' || m === 'usdc' || m === 'usd' ? m : 'usd'
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50))

  const artists = await getEarningsLeaderboard(metric, limit)
  return NextResponse.json({ metric, artists })
}
