import { NextRequest, NextResponse } from 'next/server'
import { getLeaderboard, type EarningsMetric } from '@/lib/stats'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Public top-artists feed (PRIMARY SALES ONLY). Ranks by `metric`:
//   - sold → total artworks (editions) sold
//   - eth  → gross ETH earned  (default)
//   - usdc → gross USDC earned
// Every row carries all three figures regardless of the ranking metric.
// Admin-hidden users are stripped inside getLeaderboard.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`leaderboard:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const { searchParams } = new URL(req.url)
  const m = searchParams.get('metric')
  const metric: EarningsMetric = m === 'sold' || m === 'usdc' || m === 'eth' ? m : 'eth'
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '50', 10) || 50))

  const artists = await getLeaderboard(metric, limit)
  return NextResponse.json({ metric, artists })
}
