import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { verifyAdminSession } from '@/lib/curator'
import { clearWinner, isEntered, setWinner } from '@/lib/raffle'

/**
 * Admin-only: choose the raffle winner (POST) or clear it to re-pick (DELETE).
 * Picking a winner also closes entries. The winner must be an existing
 * entrant. "Announce only" — this records the result; nothing is burned and
 * the winner keeps their edition.
 */
export async function POST(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    collection?: string
    tokenId?: string
    address?: string
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const collection = body.collection?.toLowerCase()
  const tokenId = body.tokenId
  const address = body.address?.toLowerCase()

  if (!collection || !isAddress(collection) || !tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid raffle')
  }
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid winner address')
  }

  // Guard against picking a non-entrant (typo, stale UI).
  if (!(await isEntered(collection, tokenId, address))) {
    return errorResponse(400, 'That address is not an entrant')
  }

  await setWinner(collection, tokenId, address)
  return NextResponse.json({ ok: true, winner: address })
}

export async function DELETE(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const sp = req.nextUrl.searchParams
  const collection = sp.get('collection')?.toLowerCase()
  const tokenId = sp.get('tokenId')
  if (!collection || !isAddress(collection) || !tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid raffle')
  }

  await clearWinner(collection, tokenId)
  return NextResponse.json({ ok: true })
}
