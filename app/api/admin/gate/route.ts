import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getGateConfig, setGateConfig } from '@/lib/gate'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-gate-get:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Admin-only — matches every other /api/admin/* GET. The admin sub-pages
  // (/admin/gate, /admin/pass) carry the HttpOnly session cookie which the
  // browser auto-attaches on same-origin fetches, so the existing UI works
  // without code changes. The previous unauth GET was a no-longer-justified
  // hole left over from when /api/gate was a public read; that route is
  // gone and no UI consumes this endpoint without admin context.
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const config = await getGateConfig()
  return NextResponse.json(config)
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-gate:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Admin-only — gate config affects every gated mutation and is the
  // platform-policy source of truth. Curators with featured-feed
  // privileges should not be able to flip it.
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    enabled?: boolean
    passCollection?: string
    paused?: boolean
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (typeof body.enabled !== 'boolean') {
    return errorResponse(400, 'enabled must be boolean')
  }
  // Preserve existing values when admin omits them. Each field is
  // independently togglable so admin can pause without re-supplying the
  // collection, or change the collection without re-supplying pause state.
  // Empty string explicitly clears passCollection; undefined preserves.
  const existing = await getGateConfig()
  let passCollection: string | null = existing.passCollection
  if (body.passCollection !== undefined) {
    if (body.passCollection === '') {
      passCollection = null
    } else if (!isAddress(body.passCollection)) {
      return errorResponse(400, 'passCollection must be a valid address')
    } else {
      passCollection = body.passCollection.toLowerCase()
    }
  }
  const paused = typeof body.paused === 'boolean' ? body.paused : existing.paused
  if (body.enabled && !passCollection) {
    return errorResponse(400, 'passCollection is required when enabling the gate')
  }
  await setGateConfig({ enabled: body.enabled, passCollection, paused })
  return NextResponse.json({ ok: true })
}
