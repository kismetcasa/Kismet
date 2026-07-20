import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getValidBalance, setValidBalance } from '@/lib/pass-validity'
import { getGateConfig } from '@/lib/gate'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-pass-validity:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET /api/admin/pass-validity?address=0x... — read current validBalance for
 *  an address against the configured pass collection. Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const url = new URL(req.url)
  const address = url.searchParams.get('address')
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'valid address required')
  }

  const config = await getGateConfig()
  if (!config.passCollection) {
    return errorResponse(400, 'No pass collection configured')
  }

  const validBalance = await getValidBalance(config.passCollection, address)
  return NextResponse.json({
    collection: config.passCollection,
    address: address.toLowerCase(),
    validBalance,
  })
}

/** POST /api/admin/pass-validity — set the validBalance for an address to an
 *  explicit value. Used to grant validity to a known-good holder whose
 *  webhook event was missed, OR to revoke a specific bad-actor without
 *  nuking the whole Pass collection. Admin-only. */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    address?: string
    value?: number
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }
  const value = Number(body.value)
  if (!Number.isFinite(value) || value < 0) {
    return errorResponse(400, 'value must be a non-negative number')
  }
  // Cap to a sane upper bound so admin can't accidentally set values that
  // overflow JS Number precision when later compared to BigInt liveBalance.
  const MAX_VALID_BALANCE = 1_000_000
  if (value > MAX_VALID_BALANCE) {
    return errorResponse(400, `value must be ≤ ${MAX_VALID_BALANCE}`)
  }

  const config = await getGateConfig()
  if (!config.passCollection) {
    return errorResponse(400, 'No pass collection configured — set one in /admin/gate first')
  }

  await setValidBalance(config.passCollection, body.address, Math.floor(value))
  await recordAdminAction('pass-validity.set', {
    actor: auth.signer,
    target: body.address.toLowerCase(),
    meta: { value: Math.floor(value), collection: config.passCollection },
  })
  return NextResponse.json({ ok: true })
}
