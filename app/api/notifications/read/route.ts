import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { markAllRead, markOneRead } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function PATCH(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-read:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = (await req.json()) as { address?: string; all?: boolean; id?: string }
  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  if (body.all) {
    await markAllRead(body.address)
  } else if (body.id) {
    await markOneRead(body.address, body.id)
  } else {
    return NextResponse.json({ error: 'Provide either all=true or an id' }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
