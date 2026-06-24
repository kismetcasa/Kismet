import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getEntrantCount, getRaffleState, getWinner, isEntered } from '@/lib/raffle'

/**
 * Public raffle status for a (collection, tokenId). Drives RaffleButton and the
 * /patron page. With `address`, also reports whether that wallet is entered and
 * whether it is the announced winner. The winner address is returned for public
 * transparency (the result is an announcement).
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`raffle-status:${ip}`, 120, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const sp = req.nextUrl.searchParams
  const collection = sp.get('collection')?.toLowerCase()
  const tokenId = sp.get('tokenId')
  const address = sp.get('address')?.toLowerCase() ?? null

  if (!collection || !isAddress(collection) || !tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid raffle')
  }
  if (address && !isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }

  const [state, entrantCount, winner] = await Promise.all([
    getRaffleState(collection, tokenId),
    getEntrantCount(collection, tokenId),
    getWinner(collection, tokenId),
  ])
  const entered = address ? await isEntered(collection, tokenId, address) : false
  const isWinner = !!address && !!winner && winner.toLowerCase() === address

  return NextResponse.json({
    open: state === 'open',
    entrantCount,
    entered,
    winner,
    winnerChosen: !!winner,
    isWinner,
  })
}
