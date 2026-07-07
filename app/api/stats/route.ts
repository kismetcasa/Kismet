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
//
// The private-path response carries `authRequired: true` when the request had
// NO credentials at all (401 from the owner gate) — the card renders a sign-in
// affordance instead of silently unmounting, which left session-less owners
// with no card, no error, and no way to reach the pin (the only opt-in
// surface). A flag on the 200 rather than a 401 status because this GET is a
// mixed public/private resource: the pin state IS served, only the figures are
// withheld. It leaks nothing (every anonymous caller gets the same flag), and
// a signed-in NON-owner (403) deliberately gets the bare visitor shape — a
// sign-in prompt would be a lie for them.
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
  if (!isPublic && 'error' in auth) {
    return NextResponse.json({
      public: false,
      ...(auth.status === 401 ? { authRequired: true } : {}),
    })
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
