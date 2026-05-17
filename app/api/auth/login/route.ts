import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { parseSiweMessage, verifySiweMessage } from 'viem/siwe'
import { redis } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { ADMIN_ADDRESS, CURATOR_ADDRESSES } from '@/lib/config'
import { ADMIN_SESSION_COOKIE } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

// 4 hours — matches the prior signature-TTL UX so admins/curators sign
// once per work session. Stored server-side in Redis so we can revoke
// or shrink the window without changing the client.
const SESSION_TTL_SECONDS = 4 * 60 * 60

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
  if (!/^0x[0-9a-fA-F]+$/.test(body.signature)) {
    return errorResponse(400, 'Invalid signature shape')
  }

  // Parse first so we can bind verification to the message's own nonce +
  // address. Mismatched values cause verifySiweMessage to fail closed.
  let parsed
  try {
    parsed = parseSiweMessage(body.message)
  } catch {
    return errorResponse(400, 'Invalid SIWE message')
  }
  const { address, nonce, domain } = parsed
  if (!address || !nonce || !domain) {
    return errorResponse(400, 'SIWE message missing required fields')
  }

  // Domain binding: the message must claim the same host the request was
  // sent to. Prevents a curator's signature obtained for kismet.art from
  // being replayed on a malicious clone (CSRF / phishing protection).
  // Compare lowercased because the Host header is case-insensitive per
  // HTTP, and clients (RainbowKit / browsers) can normalize differently.
  const expectedDomain = req.headers.get('host')?.toLowerCase()
  if (!expectedDomain || domain.toLowerCase() !== expectedDomain) {
    return errorResponse(401, 'Domain mismatch')
  }

  // Verify signature against the message, with viem also asserting the
  // message's expirationTime hasn't passed.
  const verified = await verifySiweMessage(serverBaseClient(), {
    message: body.message,
    signature: body.signature as `0x${string}`,
    domain: expectedDomain,
    nonce,
  })
  if (!verified) {
    return errorResponse(401, 'Signature verification failed')
  }

  // Privilege check after signature verification so we don't leak whether
  // an address is privileged via timing differences on early-return paths.
  const signer = address.toLowerCase()
  const isAdmin = signer === ADMIN_ADDRESS
  const isCurator = CURATOR_ADDRESSES.includes(signer)
  if (!isAdmin && !isCurator) {
    return errorResponse(403, 'Not authorized')
  }

  // Consume the nonce atomically. DEL returns the number of keys removed —
  // 1 means we just consumed a valid nonce; 0 means it was already used or
  // expired. Doing this AFTER signature verification means a failed-sig
  // attempt doesn't burn the nonce (the legitimate user can retry).
  const consumed = await redis.del(`kismetart:auth-nonce:${nonce}`).catch(() => 0)
  if (consumed !== 1) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  // Issue an opaque session token. 32 random bytes = 256 bits, well beyond
  // any practical brute force. The token never leaves Redis + the cookie;
  // there's no JWT to forge offline.
  const token = randomBytes(32).toString('hex')
  await redis.set(`kismetart:auth-session:${token}`, signer, { ex: SESSION_TTL_SECONDS })

  const res = NextResponse.json({ ok: true, address: signer })
  res.cookies.set(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: SESSION_TTL_SECONDS,
    path: '/',
  })
  return res
}
