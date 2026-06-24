import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { verifyAdminSession } from '@/lib/curator'
import {
  getEntrants,
  getRaffleState,
  getWinner,
  holdsEditionBatch,
} from '@/lib/raffle'

/**
 * Admin-only: the full entrant list for a raffle, with each entrant's
 * current on-chain holding (so the admin can avoid picking someone who has
 * since sold their edition). Feeds the RaffleAdminPanel picker.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const sp = req.nextUrl.searchParams
  const collection = sp.get('collection')?.toLowerCase()
  const tokenId = sp.get('tokenId')
  if (!collection || !isAddress(collection) || !tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid raffle')
  }

  const [entrants, winner, state] = await Promise.all([
    getEntrants(collection, tokenId),
    getWinner(collection, tokenId),
    getRaffleState(collection, tokenId),
  ])

  const holding = await holdsEditionBatch(
    collection,
    tokenId,
    entrants.map((e) => e.address),
  )

  return NextResponse.json({
    entrants: entrants.map((e) => ({ ...e, holdsNow: holding[e.address] ?? false })),
    winner,
    state,
    count: entrants.length,
  })
}
