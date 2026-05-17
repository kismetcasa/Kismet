import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { muteActor, unmuteActor, getMutedActors } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'

// Mute list is per-user. Cookie-authenticated to match GET /api/notifications
// — only the session owner can read their own list.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute-get:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const ctx = await getSessionContext(req)
  if (!ctx) return errorResponse(401, 'Sign in to continue')

  const muted = await getMutedActors(ctx.address)
  const res = NextResponse.json({ muted }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
  await slideSession(res, ctx.token)
  return res
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute:${ip}`, 30, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Mutating someone else's mute list would be a low-cost griefing vector.
  // Session cookie required.
  const ctx = await getSessionContext(req)
  if (!ctx) return errorResponse(401, 'Sign in to continue')

  const body = (await req.json()) as { actor?: string; unmute?: boolean }
  if (!body.actor || !isAddress(body.actor)) {
    return errorResponse(400, 'Invalid actor')
  }

  if (body.unmute) {
    await unmuteActor(ctx.address, body.actor)
  } else {
    await muteActor(ctx.address, body.actor)
  }

  const res = NextResponse.json({ ok: true })
  await slideSession(res, ctx.token)
  return res
}
