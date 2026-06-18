import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getArtistEarnings } from '@/lib/stats'
import { isEarningsPublic } from '@/lib/earningsVisibility'
import { authorizeProfileOwner } from '@/lib/profileOwner'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

// Public single-artist earnings, feeding the profile card. Earnings are PRIVATE
// by default: return the figures only when the artist pinned them public, or to
// the owner themselves (session). Otherwise return just the visibility flag, so
// the owner's own card knows its pin state without leaking amounts to visitors.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`stats:${ip}`, 120, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const artist = new URL(req.url).searchParams.get('artist')
  if (!artist || !isAddress(artist)) {
    return errorResponse(400, 'Invalid artist address')
  }

  const isPublic = await isEarningsPublic(artist)
  let isOwner = false
  if (!isPublic) {
    // Only resolve ownership when needed (private profile) — keeps the public
    // path to a single SISMEMBER.
    const auth = await authorizeProfileOwner(req, artist)
    isOwner = !('error' in auth)
  }
  if (!isPublic && !isOwner) {
    return NextResponse.json({ public: false })
  }

  const stats = await getArtistEarnings(artist)
  return NextResponse.json({ ...stats, public: isPublic })
}
