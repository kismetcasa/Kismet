import { NextRequest, NextResponse } from 'next/server'
import { getGateConfig } from '@/lib/gate'
import { listTaintedTokenIds, removeTaint } from '@/lib/pass-validity'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-taint:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET /api/admin/taint — list all tainted tokenIds for the pass collection.
 *  Tainted tokenIds can never confer validity; use DELETE to remediate false
 *  taints. Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const config = await getGateConfig()
  if (!config.passCollection) {
    return errorResponse(400, 'No pass collection configured')
  }

  const tokenIds = await listTaintedTokenIds(config.passCollection)
  return NextResponse.json({ collection: config.passCollection, tainted: tokenIds })
}

/** DELETE /api/admin/taint — remove a tokenId from the taint set.
 *
 *  Use when a tokenId was incorrectly tainted — e.g. the keyKismetListed
 *  flag was missing (Redis down at listing creation) so processTransfer
 *  tainted a legitimate Kismet secondary sale.
 *
 *  This does NOT retroactively restore credits to addresses that were denied
 *  by the false taint — those addresses must be granted manually via
 *  POST /api/admin/pass-validity. Future acquisitions of the un-tainted
 *  tokenId will credit normally. Admin-only. */
export async function DELETE(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { tokenId?: string } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (!body.tokenId || !/^\d+$/.test(body.tokenId)) {
    return errorResponse(400, 'tokenId must be a non-negative integer string')
  }
  // Canonicalize to avoid removing "01" while "1" remains tainted (same
  // tokenId, different string forms — match the pattern used at ingest time).
  const tokenId = BigInt(body.tokenId).toString()

  const config = await getGateConfig()
  if (!config.passCollection) {
    return errorResponse(400, 'No pass collection configured')
  }

  await removeTaint(config.passCollection, tokenId)
  return NextResponse.json({ ok: true, tokenId })
}
