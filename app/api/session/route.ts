import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
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
import { errorResponse } from '@/lib/apiResponse'

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

  let body: { address?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'Valid address required')
  }
  if (!body.signature || !body.nonce) {
    return errorResponse(400, 'signature and nonce required')
  }

  const message = `Sign in to Kismet\nAddress: ${body.address.toLowerCase()}\nNonce: ${body.nonce}`
  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: body.address as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    return errorResponse(401, 'Invalid signature')
  }
  if (!sigValid) return errorResponse(401, 'Signature verification failed')

  // Verify-then-consume: a failed sig leaves the nonce reusable, so an
  // attacker can't burn nonces with bogus sigs to DoS sign-in.
  const nonceValid = await consumeNonce(body.address, body.nonce)
  if (!nonceValid) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  const token = await createSession(body.address)
  // ttl returned so clients can decide when to refresh — but the cookie's
  // Max-Age is the single source of truth; clients that rely on it have no
  // need to track expiry locally.
  const res = NextResponse.json({ ok: true, address: body.address.toLowerCase(), ttl: SESSION_TTL_SECONDS })
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
