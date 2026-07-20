import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { addToBlacklist, removeFromBlacklist, listBlacklist } from '@/lib/blacklist'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-blacklist:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const addresses = await listBlacklist()
  return NextResponse.json({ addresses })
}

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
    await addToBlacklist(body.address)
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'Add failed')
  }
  await recordAdminAction('blacklist.add', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}

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
  await removeFromBlacklist(body.address)
  await recordAdminAction('blacklist.remove', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}
