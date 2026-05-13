import { NextRequest, NextResponse } from 'next/server'
import { ALL_NOTIFICATION_TYPES, getNotifications, type NotificationType } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-list:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Notification feeds are private — anyone with a valid session cookie can
  // only read their own notifications. Comments + actor metadata can carry
  // social signal we don't want to leak across users by address-guessing.
  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const tabParam = searchParams.get('tab')
  const tab = tabParam === 'priority' ? 'priority' : 'all'
  const typeParam = searchParams.get('type')
  const type = typeParam && (ALL_NOTIFICATION_TYPES as readonly string[]).includes(typeParam)
    ? (typeParam as NotificationType)
    : undefined
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 1), 50)
  const page = Math.max(parseInt(searchParams.get('page') ?? '1', 10) || 1, 1)

  const result = await getNotifications(ctx.address, { tab, type, limit, page })
  // Cache-Control: private prevents intermediaries (CDNs, browser shared
  // caches) from storing user-specific data. no-store stops the browser
  // from caching it locally too — a logged-out user opening the same URL
  // on the same device shouldn't see prior notifications from cache.
  const res = NextResponse.json(result, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
  await slideSession(res, ctx.token)
  return res
}
