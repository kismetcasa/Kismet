import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import {
  addHiddenUser,
  removeHiddenUser,
  listHiddenUsers,
} from '@/lib/hidden-users'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-hidden-users:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET — list all admin-hidden addresses (sorted). Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const addresses = await listHiddenUsers()
  return NextResponse.json({ addresses })
}

/** POST — hide every public-feed entry authored by {address}. Their own
 *  profile still surfaces their content to themselves. Admin-only. */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { address?: string } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }

  try {
    await addHiddenUser(body.address)
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'Add failed')
  }
  await recordAdminAction('user-content.hide', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}

/** DELETE — un-hide {address}'s content. Their content returns to all
 *  public feeds. Per-content hides (hiddenMoments, hiddenCollections)
 *  are NOT affected — those are independent and stay as set. */
export async function DELETE(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as { address?: string } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }
  await removeHiddenUser(body.address)
  await recordAdminAction('user-content.unhide', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}
