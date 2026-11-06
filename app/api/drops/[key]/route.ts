import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { getDrop, listClaims } from '@/lib/arkiv/drops'
import { isDropsEnabled } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * GET /api/drops/{key}[?viewer=0x…] — one drop and every Kismet-written claim
 * on it, read from Arkiv. `viewerClaimed` tells the page whether to show
 * "claimed"; the claim list is what the artist airdrops to at settlement.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`drops-get:${ip}`, 120, 60))) return errorResponse(429, 'Too many requests')
  if (!(await isDropsEnabled())) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')
  const key = normalizeEntityKey(raw)

  const viewerParam = req.nextUrl.searchParams.get('viewer')
  const viewer = viewerParam && isAddress(viewerParam) ? viewerParam.toLowerCase() : null

  try {
    const drop = await getDrop(key)
    if (!drop) return errorResponse(404, 'Drop not found — it may have expired')
    const claims = await listClaims(key)
    const viewerClaimed = viewer ? claims.some((c) => c.collector === viewer || c.owner === viewer) : false
    return NextResponse.json(
      { drop: { ...drop, claimCount: Math.max(drop.claimCount, claims.length) }, claims, viewerClaimed },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-get')
  }
}
