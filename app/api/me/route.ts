import { NextRequest, NextResponse } from 'next/server'
import { getSessionAddress } from '@/lib/session'
import { getFarcasterProfileByAddress } from '@/lib/farcasterProfile'

// Returns the currently-authenticated user's address plus, when
// available, the Farcaster profile attached to that address. The frontend
// calls this once on mount inside a Mini App (after acquiring the Quick
// Auth JWT) to learn the resolved identity for the session — there's no
// other way for the client to discover the FID → primary-address mapping
// since the JWT only carries the FID.
//
// On regular web (cookie-authed sessions) this also works: it returns the
// signed-in user's address plus any FC profile attached to it, which is
// how we auto-propagate Farcaster identity to web visitors too.
export async function GET(req: NextRequest) {
  const address = await getSessionAddress(req)
  if (!address) {
    return NextResponse.json(
      { error: 'Not authenticated' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  const farcaster = await getFarcasterProfileByAddress(address)
  return NextResponse.json(
    { address, farcaster },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
