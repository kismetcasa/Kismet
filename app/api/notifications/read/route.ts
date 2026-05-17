import { NextRequest, NextResponse } from 'next/server'
import { markAllRead, markOneRead } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'

export async function PATCH(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-read:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Mark-read mutates the caller's own notifications. Tying it to the session
  // cookie prevents drive-by writes from anyone who can guess an address.
  const ctx = await getSessionContext(req)
  if (!ctx) return errorResponse(401, 'Sign in to continue')

  const body = (await req.json()) as { all?: boolean; id?: string }

  if (body.all) {
    await markAllRead(ctx.address)
  } else if (body.id) {
    await markOneRead(ctx.address, body.id)
  } else {
    return errorResponse(400, 'Provide either all=true or an id')
  }

  const res = NextResponse.json({ ok: true })
  await slideSession(res, ctx.token)
  return res
}
