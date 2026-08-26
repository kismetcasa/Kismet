import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'
import { getNotifNudgeAt, setNotifNudge } from '@/lib/notifNudge'

// Admin control for the "turn notifications on" nudge campaign
// (lib/notifNudge). POST starts a new campaign (every Mini App user without
// push sees ONE prompt on their next open); DELETE stops it (users who
// haven't opened since simply never see it); GET reads the current stamp.
// Starting a new campaign re-prompts everyone once — the per-device seen
// marker is compared against the stamp, not a boolean.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-notif-nudge:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  return NextResponse.json({ notifNudgeAt: await getNotifNudgeAt() })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-notif-nudge:${ip}`, 10, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const at = Date.now()
  await setNotifNudge(at)
  await recordAdminAction('notif-nudge.start', { actor: auth.signer, meta: { at } })
  return NextResponse.json({ notifNudgeAt: at })
}

export async function DELETE(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`admin-notif-nudge:${ip}`, 10, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  await setNotifNudge(null)
  await recordAdminAction('notif-nudge.stop', { actor: auth.signer, meta: {} })
  return NextResponse.json({ notifNudgeAt: null })
}
