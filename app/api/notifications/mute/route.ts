import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { muteActor, unmuteActor, getMutedActors } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'

// Mute list is per-user. Cookie-authenticated to match GET /api/notifications
// — only the session owner can read their own list.
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute-get:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const address = await getSessionAddress(req)
  if (!address) {
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  const muted = await getMutedActors(address)
  return NextResponse.json({ muted })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute:${ip}`, 30, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Mutating someone else's mute list would be a low-cost griefing vector.
  // Session cookie required.
  const address = await getSessionAddress(req)
  if (!address) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const body = (await req.json()) as { actor?: string; unmute?: boolean }
  if (!body.actor || !isAddress(body.actor)) {
    return NextResponse.json({ error: 'Invalid actor' }, { status: 400 })
  }

  if (body.unmute) {
    await unmuteActor(address, body.actor)
  } else {
    await muteActor(address, body.actor)
  }

  return NextResponse.json({ ok: true })
}
