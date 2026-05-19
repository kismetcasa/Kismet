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
  getPushMaster,
  setPushMaster,
} from '@/lib/farcasterNotifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionContext, slideSession } from '@/lib/session'

// GET → { enabled, all, hasTokens, fid, master }
//   master: 'on' | 'off'   (default-off when never set; surfaced as 'off'
//                           so the UI shows a consistent boolean state)
//
// PATCH { type, enabled }   → flip one type's opt-in
// PATCH { master: boolean } → flip the master toggle
//
// Per-type FC push opt-in plus the master gate. Mirrors
// /api/notifications/mute-type's GET/PATCH shape but with inverted
// semantics: this is OPT-IN (defaults to {collect}, master default-off),
// the mute endpoint is opt-OUT (defaults to {}).
//
// `hasTokens` and `fid` let the settings UI render context:
//   - fid == null     → user has no FC identity ("connect FC to enable push")
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
  const [enabled, tokens, master] = fid
    ? await Promise.all([
        getEnabledPushTypes(fid),
        hasAnyToken(fid),
        getPushMaster(fid),
      ])
    : [[] as NotificationType[], false, null]

  const res = NextResponse.json(
    {
      enabled,
      all: ALL_NOTIFICATION_TYPES,
      hasTokens: tokens,
      fid,
      // Surface as a boolean to keep the UI dead simple. null (never set)
      // collapses to 'off' here so the toggle renders consistently.
      master: master === 'on',
    },
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
    | { type?: string; enabled?: boolean; master?: boolean }
    | null

  // Disambiguate the two mutations by shape, not by a separate path,
  // so the toggle UI doesn't have to know about endpoint variants.
  const isMaster = typeof body?.master === 'boolean'
  const isType =
    typeof body?.type === 'string' && typeof body?.enabled === 'boolean'

  if (!isMaster && !isType) {
    return NextResponse.json(
      { error: 'Provide either { master: boolean } or { type, enabled }' },
      { status: 400 },
    )
  }
  if (isMaster && isType) {
    return NextResponse.json(
      { error: 'Provide exactly one of master/type in a single request' },
      { status: 400 },
    )
  }
  if (isType) {
    const type = body!.type as NotificationType
    if (!(ALL_NOTIFICATION_TYPES as readonly string[]).includes(type)) {
      return NextResponse.json({ error: 'Unknown notification type' }, { status: 400 })
    }
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

  if (isMaster) {
    await setPushMaster(fid, body!.master as boolean)
  } else {
    await setPushTypeEnabled(fid, body!.type as NotificationType, body!.enabled as boolean)
  }

  const res = NextResponse.json({ ok: true, fid })
  await slideSession(res, ctx.token)
  return res
}
