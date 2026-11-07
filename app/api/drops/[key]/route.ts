import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { getDropDetail, isDropsEnabled } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * GET /api/drops/{key}[?viewer=0x…] — one drop and every Kismet-written claim
 * on it, read from Arkiv (cached briefly, lib/dropsStore). `viewerClaimed`
 * means the viewer OWNS a claim — the airdrop goes to owners. The claim list
 * is what the artist airdrops to at settlement; `settlement` is the verified
 * delivery once it happened (the Base token and the airdrop transaction).
 * Served from the shared cache, so the per-IP limit is generous (a venue
 * shares one address and the page polls).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!(await checkRateLimit(`drops-get:${getClientIp(req)}`, 600, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')

  const viewerParam = req.nextUrl.searchParams.get('viewer')
  const viewer = viewerParam && isAddress(viewerParam) ? viewerParam.toLowerCase() : null

  try {
    const detail = await getDropDetail(normalizeEntityKey(raw))
    if (!detail) return errorResponse(404, 'Drop not found — it may have expired')
    const { drop, claims, settlement } = detail
    return NextResponse.json(
      {
        drop: { ...drop, claimCount: claims.length, delivered: settlement !== null },
        claims,
        settlement,
        viewerClaimed: viewer !== null && claims.some((c) => c.owner === viewer),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-get')
  }
}
