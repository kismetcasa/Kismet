import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { verifyAdminSession } from '@/lib/curator'
import {
  clearRaffleEnabled,
  getEnabledRaffles,
  setRaffleEnabled,
} from '@/lib/raffle'

/**
 * Per-moment raffle enablement, modelled on /api/featured.
 *
 *   GET    public — the full set of raffle-enabled (collection, tokenId) pairs.
 *          The client loads this once on mount (AdminContext.raffleEnabledKeys)
 *          so owned-edition surfaces decide "enter raffle" vs "list"
 *          synchronously, with no per-card request.
 *   POST   admin  — enable the raffle for one moment.
 *   DELETE admin  — disable it (entrants/winner are preserved for re-enable).
 *
 * Admin-only writes (verifyAdminSession), matching the other raffle admin
 * routes (entrants, winner). Eventually a mint-time toggle can write the same
 * set; this route is the manual path until then.
 */
export async function GET() {
  const enabled = await getEnabledRaffles()
  return NextResponse.json({ enabled })
}

function parseBody(raw: unknown): { collection: string; tokenId: string } | null {
  const body = raw as { collection?: string; tokenId?: string } | null
  if (!body) return null
  const collection = body.collection?.toLowerCase()
  const tokenId = body.tokenId
  if (!collection || !isAddress(collection)) return null
  if (!tokenId || !/^\d+$/.test(tokenId)) return null
  return { collection, tokenId }
}

export async function POST(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const parsed = parseBody(await req.json().catch(() => null))
  if (!parsed) return errorResponse(400, 'Invalid raffle')

  await setRaffleEnabled(parsed.collection, parsed.tokenId)
  return NextResponse.json({ enabled: true })
}

export async function DELETE(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const parsed = parseBody(await req.json().catch(() => null))
  if (!parsed) return errorResponse(400, 'Invalid raffle')

  await clearRaffleEnabled(parsed.collection, parsed.tokenId)
  return NextResponse.json({ enabled: false })
}
