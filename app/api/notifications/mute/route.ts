import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { muteActor, unmuteActor } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute:${ip}`, 30, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = (await req.json()) as { address?: string; actor?: string; unmute?: boolean }
  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  if (!body.actor || !isAddress(body.actor)) {
    return NextResponse.json({ error: 'Invalid actor' }, { status: 400 })
  }

  if (body.unmute) {
    await unmuteActor(body.address, body.actor)
  } else {
    await muteActor(body.address, body.actor)
  }

  return NextResponse.json({ ok: true })
}
