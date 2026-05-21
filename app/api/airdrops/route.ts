import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getAirdropsBySender } from '@/lib/airdrops'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getSessionAddress } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Lists airdrops sent by the given artist for ProfileView's airdrops section.
 * Reads from the local Redis store written by `POST /api/airdrop/notify` —
 * Kismet airdrops are submitted client-side via Zora's `adminMint`
 * (see hooks/useAirdrop.ts), so inprocess's own /api/airdrops never observes
 * them. We also short-circuit calls for non-owners; this is metadata about
 * the caller's outgoing activity and is currently rendered only on a profile
 * the connected wallet owns.
 *
 * Response shape (preserved from the previous inprocess proxy so ProfileView
 * doesn't have to branch):
 *   { airdrops: [{ collectionAddress, tokenId, recipient: {address, username?},
 *                   amount, txHash?, timestamp }] }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist_address') ?? searchParams.get('artist')
  const offsetParam = searchParams.get('offset')
  const limitParam = searchParams.get('limit')

  if (!artist || !isAddress(artist)) {
    return errorResponse(400, 'Invalid artist_address')
  }

  const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0
  const limit = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 100)) : 100

  // Hidden-users gate: airdrops sent by an admin-hidden artist are
  // stripped from public surfaces. Same own-profile exception as the
  // per-content hide pattern — the artist themselves still sees their
  // outgoing airdrops on their own profile. Both reads run in parallel
  // because they're independent (viewer ≠ artist constraint).
  const [hiddenUsers, viewer] = await Promise.all([
    getHiddenUsersSet(),
    getSessionAddress(req),
  ])
  const artistLower = artist.toLowerCase()
  if (hiddenUsers.has(artistLower) && viewer?.toLowerCase() !== artistLower) {
    return NextResponse.json({ airdrops: [] }, { status: 200 })
  }

  try {
    const airdrops = await getAirdropsBySender(artist, { offset, limit })
    return NextResponse.json({ airdrops }, { status: 200 })
  } catch {
    return NextResponse.json({ airdrops: [] }, { status: 200 })
  }
}
