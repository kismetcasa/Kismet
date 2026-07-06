import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import {
  addHiddenProfile,
  removeHiddenProfile,
  listHiddenProfiles,
} from '@/lib/hidden-profiles'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-hidden-profiles:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET — list all admin-hidden profile addresses (sorted). Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const addresses = await listHiddenProfiles()
  return NextResponse.json({ addresses })
}

/** POST — hide {address}'s profile: the profile page 404s for everyone
 *  but the owner, and their identity drops out of the profile API, batch
 *  resolver, search, and share cards. Their CONTENT keeps its existing
 *  visibility — pair with hidden-users to strip that too. Admin-only. */
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
    await addHiddenProfile(body.address)
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'Add failed')
  }
  return NextResponse.json({ ok: true })
}

/** DELETE — un-hide {address}'s profile. Identity surfaces return for
 *  everyone. Other moderation lists (hidden-users, blacklists) are NOT
 *  affected — those are independent and stay as set. */
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
  await removeHiddenProfile(body.address)
  return NextResponse.json({ ok: true })
}
