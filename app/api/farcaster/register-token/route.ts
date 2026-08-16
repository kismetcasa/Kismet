import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { verifyFarcasterJwt } from '@/lib/farcasterAuth'
import { registerToken } from '@/lib/farcasterNotifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'

// POST /api/farcaster/register-token   { url, token }
//
// Client-side notification-token self-registration. The Mini App context the
// host delivers on every launch carries `client.notificationDetails` — the
// SAME (url, token) pair the miniapp_added / notifications_enabled webhook
// would have POSTed to us. FarcasterProvider forwards it here fire-and-forget
// on each open.
//
// Why this exists when the webhook already does the job: the webhook is a
// one-shot delivery at grant time. If it is ever missed — host retry budget
// exhausted, endpoint bug, or the incident that motivated this route (the
// hub.farcaster.xyz sunset silently 401'ing verification for months, so NO
// token was ever stored) — the grant is lost until the user manually toggles
// notifications. Context self-heal closes that permanently: every active
// user re-registers their live token on next open, so token storage
// converges with reality regardless of webhook history. Removals still
// arrive via webhook only; a token that outlives its grant is caught by the
// host's invalidTokens response and GC'd on first send.
//
// Auth: Quick Auth Bearer JWT (Mini-App-only, same posture as /api/me/identity
// — web sessions have no notification context to register). The verified
// `sub` claim is the FID, so a caller can only ever register tokens for
// THEIR OWN fid; the blast radius of a forged body is the caller receiving
// (or not receiving) their own notifications.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`fc-register-token:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const auth = req.headers.get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return errorResponse(401, 'Sign in via Farcaster to continue')
  }
  const jwt = auth.slice('Bearer '.length).trim()
  if (!jwt) return errorResponse(401, 'Missing token')
  const session = await verifyFarcasterJwt(jwt)
  if (!session) return errorResponse(401, 'Invalid token')

  let body: { url?: unknown; token?: unknown }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const url = typeof body.url === 'string' ? body.url.trim() : ''
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  // Bounds are defensive sanity caps, not spec values (the spec doesn't cap
  // these) — sized far above anything hosts issue today.
  if (!url || url.length > 1024) return errorResponse(400, 'Invalid url')
  if (!token || token.length > 512) return errorResponse(400, 'Invalid token')
  // registerToken re-checks this and silently drops on failure; checking here
  // too turns a client-side bug into a visible 400 instead of a silent no-op.
  if (!isSafePublicHttpsUrl(url)) return errorResponse(400, 'url must be a public https endpoint')

  await registerToken(session.fid, { url, token })
  return NextResponse.json(
    { ok: true },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
