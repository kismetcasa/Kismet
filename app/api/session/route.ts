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

/** Returns the address bound to the current session cookie, or 401. */
export async function GET(req: NextRequest) {
  const address = await getSessionAddress(req)
  if (!address) return NextResponse.json({ error: 'No session' }, { status: 401 })
  return NextResponse.json({ address, ttl: SESSION_TTL_SECONDS })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`session:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: { address?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'Valid address required' }, { status: 400 })
  }
  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 400 })
  }

  const message = `Sign in to Kismet Art\nAddress: ${body.address.toLowerCase()}\nNonce: ${body.nonce}`
  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: body.address as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

  // Verify-then-consume: a failed sig leaves the nonce reusable, so an
  // attacker can't burn nonces with bogus sigs to DoS sign-in.
  const nonceValid = await consumeNonce(body.address, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
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
