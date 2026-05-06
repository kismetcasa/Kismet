import { NextRequest, NextResponse } from 'next/server'
import { getUnreadCount } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-unread:${ip}`, 120, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Same authorization as GET /api/notifications: only the session owner
  // can poll their own unread count. The bell renders this on every nav
  // load for the connected user, so the session cookie is always present.
  const address = await getSessionAddress(req)
  if (!address) {
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  const count = await getUnreadCount(address)
  return NextResponse.json({ count })
}
