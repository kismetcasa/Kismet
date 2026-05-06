import { NextRequest, NextResponse } from 'next/server'
import { markAllRead, markOneRead } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'

export async function PATCH(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-read:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Mark-read mutates the caller's own notifications. Tying it to the session
  // cookie prevents drive-by writes from anyone who can guess an address.
  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const body = (await req.json()) as { all?: boolean; id?: string }

  if (body.all) {
    await markAllRead(ctx.address)
  } else if (body.id) {
    await markOneRead(ctx.address, body.id)
  } else {
    return NextResponse.json({ error: 'Provide either all=true or an id' }, { status: 400 })
  }

  const res = NextResponse.json({ ok: true })
  await slideSession(res, ctx.token)
  return res
}
