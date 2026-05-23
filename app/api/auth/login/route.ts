import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { redis } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { ADMIN_ADDRESS, CURATOR_ADDRESSES } from '@/lib/config'
import { ADMIN_SESSION_COOKIE, adminSessionKey, adminNonceKey } from '@/lib/curator'
import { verifySiweLogin } from '@/lib/siweLogin'
import { errorResponse } from '@/lib/apiResponse'

// 4 hours — matches the prior signature-TTL UX so admins/curators sign
// once per work session. Stored server-side in Redis so we can revoke
// or shrink the window without changing the client. Named distinct from
// the user-session TTL in lib/session.ts (7d) so a global search for one
// doesn't get a false hit on the other.
const ADMIN_SESSION_TTL_SECONDS = 4 * 60 * 60

/**
 * SIWE login. Client constructs an EIP-4361 message containing a single-
 * use nonce (issued by /api/auth/nonce) and signs it; the server verifies
 * the signature, confirms the signer is admin or curator, consumes the
 * nonce atomically, and issues an opaque session token in an HttpOnly
 * cookie. Subsequent admin requests carry the cookie (auto-attached by
 * the browser) instead of replaying the raw signature in request bodies.
 *
 * Hardens against the prior 4h replay window: a captured signature is now
 * single-use, and the resulting session token isn't accessible to client
 * JS (HttpOnly), so an XSS injection can't exfiltrate it.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`auth-login:${ip}`, 20, 60)
  if (!allowed) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as
    | { message?: unknown; signature?: unknown }
    | null
  if (!body || typeof body.message !== 'string' || typeof body.signature !== 'string') {
    return errorResponse(400, 'message and signature required')
  }

  // Shared SIWE verifier — parses the message, binds domain to the
  // request host (anti-phishing), and runs viem's verifySiweMessage
  // (which also asserts expirationTime hasn't passed and supports
  // ERC-1271 smart wallets via verifyHash).
  const verified = await verifySiweLogin(body.message, body.signature, req.headers.get('host'))
  if ('error' in verified) return errorResponse(verified.status, verified.error)
  const { address: signer, nonce } = verified

  // Privilege check after signature verification so we don't leak whether
  // an address is privileged via timing differences on early-return paths.
  const isAdmin = signer === ADMIN_ADDRESS
  const isCurator = CURATOR_ADDRESSES.includes(signer)
  if (!isAdmin && !isCurator) {
    return errorResponse(403, 'Not authorized')
  }

  // Consume the nonce atomically. DEL returns the number of keys removed —
  // 1 means we just consumed a valid nonce; 0 means it was already used or
  // expired. Doing this AFTER signature verification means a failed-sig
  // attempt doesn't burn the nonce (the legitimate user can retry).
  const consumed = await redis.del(adminNonceKey(nonce)).catch(() => 0)
  if (consumed !== 1) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  // Issue an opaque session token. 32 random bytes = 256 bits, well beyond
  // any practical brute force. The token never leaves Redis + the cookie;
  // there's no JWT to forge offline.
  const token = randomBytes(32).toString('hex')
  await redis.set(adminSessionKey(token), signer, { ex: ADMIN_SESSION_TTL_SECONDS })

  const res = NextResponse.json({ ok: true, address: signer })
  res.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ADMIN_SESSION_TTL_SECONDS,
    path: '/',
  })
  return res
}
