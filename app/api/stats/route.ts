import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getArtistEarnings } from '@/lib/stats'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Public single-artist earnings (primary paid sales). Feeds the profile stat
// strip. Returns native ETH/USDC totals, the derived USD value, and the
// paid-mint count.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`stats:${ip}`, 120, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const artist = new URL(req.url).searchParams.get('artist')
  if (!artist || !isAddress(artist)) {
    return errorResponse(400, 'Invalid artist address')
  }
  const stats = await getArtistEarnings(artist)
  return NextResponse.json(stats)
}
