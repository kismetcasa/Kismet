import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { muteActor, unmuteActor, getMutedActors } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'

// Mute list is per-user. Cookie-authenticated to match GET /api/notifications
// — only the session owner can read their own list.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute-get:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

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
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Mutating someone else's mute list would be a low-cost griefing vector.
  // Session cookie required.
  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const body = (await req.json()) as { actor?: string; unmute?: boolean }
  if (!body.actor || !isAddress(body.actor)) {
    return NextResponse.json({ error: 'Invalid actor' }, { status: 400 })
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
