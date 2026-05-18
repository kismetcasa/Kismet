import { NextRequest, NextResponse } from 'next/server'
import {
  ALL_NOTIFICATION_TYPES,
  type NotificationType,
} from '@/lib/notifications'
import {
  getEnabledPushTypes,
  setPushTypeEnabled,
  getFidForAddress,
  hasAnyToken,
} from '@/lib/farcasterNotifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'

// GET → { enabled: NotificationType[], all: NotificationType[], hasTokens: boolean, fid: number | null }
// PATCH { type, enabled } → { ok: true }
//
// Per-type FC push opt-in. Mirrors /api/notifications/mute-type's shape
// but with inverted semantics: this is OPT-IN (defaults to {collect}),
// the mute endpoint is opt-OUT (defaults to {}).
//
// `hasTokens` and `fid` let the settings UI render context:
//   - fid == null  → user has no FC identity ("connect FC to enable push")
//   - hasTokens false → user has FC but hasn't added Kismet
//                       ("add Kismet inside Farcaster to enable push")
//   - hasTokens true  → toggles are functional

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-push-types-get:${ip}`, 60, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const fid = await getFidForAddress(ctx.address)
  const [enabled, tokens] = fid
    ? await Promise.all([getEnabledPushTypes(fid), hasAnyToken(fid)])
    : [[] as NotificationType[], false]

  const res = NextResponse.json(
    { enabled, all: ALL_NOTIFICATION_TYPES, hasTokens: tokens, fid },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
  await slideSession(res, ctx.token)
  return res
}

export async function PATCH(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`notif-push-types:${ip}`, 30, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const ctx = await getSessionContext(req)
  if (!ctx) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as
    | { type?: string; enabled?: boolean }
    | null
  const type = body?.type as NotificationType | undefined
  if (!type || !(ALL_NOTIFICATION_TYPES as readonly string[]).includes(type)) {
    return NextResponse.json({ error: 'Unknown notification type' }, { status: 400 })
  }
  if (typeof body?.enabled !== 'boolean') {
    return NextResponse.json({ error: 'Missing `enabled`' }, { status: 400 })
  }

  const fid = await getFidForAddress(ctx.address)
  if (!fid) {
    // No FC identity tied to this address — settings have nowhere to land.
    // Return 200 (not 4xx) so the UI doesn't bounce a "real" auth user
    // into an error state on every toggle; the GET response already tells
    // the UI to hide the toggles in this case.
    const res = NextResponse.json({ ok: true, fid: null })
    await slideSession(res, ctx.token)
    return res
  }

  await setPushTypeEnabled(fid, type, body.enabled)
  const res = NextResponse.json({ ok: true, fid })
  await slideSession(res, ctx.token)
  return res
}
