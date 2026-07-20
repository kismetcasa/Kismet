import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  createSession,
  getSessionAddress,
  revokeSession,
  setSessionCookie,
} from '@/lib/session'
import { verifySiweLogin } from '@/lib/siweLogin'
import { errorResponse, upstreamError } from '@/lib/apiResponse'

/** Returns the address bound to the current session cookie, or 401. */
export async function GET(req: NextRequest) {
  const headers = { 'Cache-Control': 'private, no-store' }
  const address = await getSessionAddress(req)
  if (!address) {
    return NextResponse.json({ error: 'No session' }, { status: 401, headers })
  }
  return NextResponse.json({ address, ttl: SESSION_TTL_SECONDS }, { headers })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`session:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // EIP-4361 SIWE. The signed message carries the domain so a signature
  // obtained for kismet.art on a phishing clone (same text rendered to
  // the user on attacker.com) cannot be replayed against us. Wire shape
  // mirrors /api/auth/login: { message, signature } in the body.
  let body: { message?: unknown; signature?: unknown }
  try {
    body = (await req.json()) as { message?: unknown; signature?: unknown }
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  if (typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return errorResponse(400, 'message and signature required')
  }

  const expectedHost = req.headers.get('host')
  const verified = await verifySiweLogin(body.message, body.signature, expectedHost)
  if ('error' in verified) return errorResponse(verified.status, verified.error)

  // Verify-then-consume: a failed sig leaves the nonce reusable, so a
  // bogus-sig flood can't burn a legitimate user's nonce. The nonce is
  // stored against the SIGNER address (the same address that requested
  // it via /api/profile/<addr>/nonce), making this lookup symmetric
  // with the rest of the address-keyed nonce flows.
  // Both Redis legs guarded (same pattern as the nonce-issuance routes): a
  // transient blip must surface as a retryable 503, not an unhandled 500 —
  // and for the consume specifically, not a misleading 401 "invalid nonce".
  let nonceValid = false
  try {
    nonceValid = await consumeNonce(verified.address, verified.nonce)
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — please retry', err, 'session')
  }
  if (!nonceValid) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  let token: string
  try {
    token = await createSession(verified.address)
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — please retry', err, 'session')
  }
  // ttl returned so clients can decide when to refresh — but the cookie's
  // Max-Age is the single source of truth.
  const res = NextResponse.json({ ok: true, address: verified.address, ttl: SESSION_TTL_SECONDS })
  setSessionCookie(res, token)
  return res
}

export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token) await revokeSession(token)
  const res = NextResponse.json({ ok: true })
  clearSessionCookie(res)
  return res
}
