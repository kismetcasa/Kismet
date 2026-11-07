import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { getClaimsOf, isDropsEnabled } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * GET /api/drops/claims?owner=0x… — the drops a wallet has claimed, newest
 * first, each with where it stands: open, waiting for its artist, or
 * delivered (and to which Base token). Public, like the Arkiv entities it
 * reads: any app can run the same `ownedBy` query. Cached briefly per wallet.
 */
export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`drops-claims:${getClientIp(req)}`, 120, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const owner = req.nextUrl.searchParams.get('owner')
  if (!owner || !isAddress(owner)) return errorResponse(400, 'owner must be a valid address')
  try {
    return NextResponse.json({ claims: await getClaimsOf(getAddress(owner)) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-claims')
  }
}
