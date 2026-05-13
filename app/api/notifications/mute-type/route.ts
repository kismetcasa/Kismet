import { NextRequest, NextResponse } from 'next/server'
import {
  muteType,
  unmuteType,
  getMutedTypes,
  MUTEABLE_TYPES,
  type NotificationType,
} from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute-type-get:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const muted = await getMutedTypes(ctx.address)
  const res = NextResponse.json(
    { muted, muteable: MUTEABLE_TYPES },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
  await slideSession(res, ctx.token)
  return res
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-mute-type:${ip}`, 30, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { type?: string; unmute?: boolean } | null
  const type = body?.type as NotificationType | undefined
  if (!type || !MUTEABLE_TYPES.includes(type)) {
    return NextResponse.json({ error: 'This type cannot be muted' }, { status: 400 })
  }

  await (body?.unmute ? unmuteType(ctx.address, type) : muteType(ctx.address, type))

  const res = NextResponse.json({ ok: true })
  await slideSession(res, ctx.token)
  return res
}
