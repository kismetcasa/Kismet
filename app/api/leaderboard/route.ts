import { NextRequest, NextResponse } from 'next/server'
import { getEarningsLeaderboard } from '@/lib/stats'
import type { EarningsMetric } from '@/lib/earningsFormat'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Public top-artists feed (PRIMARY PAID SALES ONLY). Ranks by `metric`:
//   - eth  → total native ETH earned (stable)
//   - usdc → total native USDC earned (stable)
//   - usd  → current market value (eth × ETH/USD + usdc); default
// Every row carries all three earnings figures + the paid-mint count so a
// client can switch denomination without refetching. Admin-hidden users are
// stripped inside getEarningsLeaderboard.
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
