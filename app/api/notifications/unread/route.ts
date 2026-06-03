import { NextRequest, NextResponse } from 'next/server'
import { getUnreadCountCached } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-unread:${ip}`, 120, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const ctx = await getSessionContext(req)
  if (!ctx) return errorResponse(401, 'Sign in to continue')

  // Cached variant: most polls hit a precomputed counter (1 GET) instead
  // of the 4-op fanout the source-of-truth getUnreadCount does. Cache is
  // invalidated on every priority write + every mark-read so true changes
  // still surface on the next poll.
  const count = await getUnreadCountCached(ctx.address)
  const res = NextResponse.json({ count }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
  await slideSession(res, ctx.token)
  return res
}
