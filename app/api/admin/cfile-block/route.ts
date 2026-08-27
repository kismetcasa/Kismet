import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'
import { isAddress, isValidTokenId } from '@/lib/address'
import { isCfileBlocked, setCfileBlocked } from '@/lib/collectorFile'

// Admin kill-switch for a collector file (COLLECTOR_DOWNLOADS_DESIGN.md
// §10.2): blocking stops DOWNLOADS of an already-attached file immediately
// (the download + ticket routes check the blocked set on every request) —
// the moderation path a DMCA/abuse incident needs, distinct from the
// artist's own DELETE. The ciphertext on Arweave is permanent either way;
// the key never leaving the server is what makes blocking effective.
//
// GET  ?collection=&tokenId=            → { blocked }
// POST { collection, tokenId, blocked } → set + audit, returns { blocked }

export const dynamic = 'force-dynamic'

function parseArtwork(collection?: unknown, tokenId?: unknown): { collection: string; tokenId: string } | null {
  if (typeof collection !== 'string' || !isAddress(collection)) return null
  if (typeof tokenId !== 'string' || !isValidTokenId(tokenId)) return null
  return { collection: collection.toLowerCase(), tokenId: BigInt(tokenId).toString() }
}

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-cfile-block:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const target = parseArtwork(
    req.nextUrl.searchParams.get('collection') ?? undefined,
    req.nextUrl.searchParams.get('tokenId') ?? undefined,
  )
  if (!target) return errorResponse(400, 'Invalid collection or tokenId')
  try {
    return NextResponse.json({ blocked: await isCfileBlocked(target.collection, target.tokenId) })
  } catch {
    return errorResponse(503, 'Temporarily unavailable — try again shortly')
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-cfile-block:${ip}`, 10, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as
    | { collection?: string; tokenId?: string; blocked?: boolean }
    | null
  const target = parseArtwork(body?.collection, body?.tokenId)
  if (!target || typeof body?.blocked !== 'boolean') {
    return errorResponse(400, 'collection, tokenId and blocked are required')
  }

  await setCfileBlocked(target.collection, target.tokenId, body.blocked)
  await recordAdminAction(body.blocked ? 'cfile.block' : 'cfile.unblock', {
    actor: auth.signer,
    target: `${target.collection}:${target.tokenId}`,
  })
  return NextResponse.json({ blocked: body.blocked })
}
