import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getArtistEarnings } from '@/lib/stats'
import { getArtistPending } from '@/lib/pending'
import { expandToEarningsWallets } from '@/lib/addressUnion'
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
  // Resolve ownership unconditionally: the owner sees their pending (undistributed)
  // roll-up even when earnings are already public, and pending is owner-only so it
  // never rides the public payload. Only the owner's own ProfileStats calls this
  // route — visitors read public earnings from the profile payload — so the extra
  // session check isn't on a visitor-hot path.
  const auth = await authorizeProfileOwner(req, artist)
  const isOwner = !('error' in auth)
  if (!isPublic && !isOwner) {
    return NextResponse.json({ public: false })
  }

  // Earnings and pending both union over the artist's earnings wallets (FC
  // siblings + known inprocess smart wallets). When we compute both (owner
  // path), resolve that set ONCE here and share it so we don't pay the
  // identity resolution twice. The public/visitor path computes only
  // earnings, which resolves its own set. The extra smart-wallet members are
  // harmless to pending (they simply hold no split memberships).
  const wallets = isOwner ? await expandToEarningsWallets(artist) : undefined
  const [stats, pending] = await Promise.all([
    getArtistEarnings(artist, wallets),
    isOwner ? getArtistPending(artist, wallets) : Promise.resolve(null),
  ])
  return NextResponse.json({ ...stats, public: isPublic, ...(pending ? { pending } : {}) })
}
