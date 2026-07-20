import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import {
  addToPassBlacklist,
  removeFromPassBlacklist,
  listPassBlacklist,
} from '@/lib/pass-blacklist'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-pass-blacklist:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET — list all pass-blacklisted addresses (sorted). Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const addresses = await listPassBlacklist()
  return NextResponse.json({ addresses })
}

/** POST — deny Pass validity to {address}. Even if they hold the Pass
 *  on-chain, hasValidPass returns false and processTransfer skips the
 *  credit step. Admin-only. */
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
    await addToPassBlacklist(body.address)
  } catch (e) {
    return errorResponse(400, e instanceof Error ? e.message : 'Add failed')
  }
  await recordAdminAction('pass-blacklist.add', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}

/** DELETE — lift the Pass-blacklist on {address}. Restores normal
 *  validity rules (ledger + on-chain reconciliation). Admin-only. */
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
  await removeFromPassBlacklist(body.address)
  await recordAdminAction('pass-blacklist.remove', { actor: auth.signer, target: body.address.toLowerCase() })
  return NextResponse.json({ ok: true })
}
