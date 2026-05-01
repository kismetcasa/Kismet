import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { getUnreadCount } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-unread:${ip}`, 120, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  if (!address || !isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  const count = await getUnreadCount(address)
  return NextResponse.json({ count })
}
