import { redis } from './redis'
import { bestEffort } from './bestEffort'
import { randomBytes } from 'crypto'
import type { NextRequest, NextResponse } from 'next/server'
import { verifyFarcasterJwt } from './farcasterAuth'

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

// `__Host-` prefix is browser-enforced cookie integrity: the browser only
// accepts cookies with this prefix when they are also Secure, Path=/, and
// have NO Domain attribute set. This blocks subdomain-based cookie
// confusion attacks (an attacker on attacker.kismet.art can't set a
// cookie that overrides ours). Requires HTTPS — so we only apply the
// prefix in production. Dev (localhost http) keeps the plain name.
export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production'
    ? '__Host-kismet_session'
    : 'kismet_session'

const key = (token: string) => `kismetart:session:${token}`

export async function createSession(address: string): Promise<string> {
  // 256-bit token, matching the admin session in /api/auth/login. (UUID v4's
  // ~122 bits was already safe; this just aligns both session families.)
  const token = randomBytes(32).toString('hex')
  await redis.setex(key(token), SESSION_TTL_SECONDS, address.toLowerCase())
  return token
}

export async function verifySession(token: string): Promise<string | null> {
  return redis.get<string>(key(token))
}

export async function revokeSession(token: string): Promise<void> {
  await redis.del(key(token))
}

/**
 * Read a Farcaster Quick Auth JWT from the Authorization header, if
 * present. Used as a parallel auth path to the session cookie because
 * the cookie is SameSite=Lax and therefore not sent on cross-site iframe
 * subresource requests (i.e. all requests from a Mini App embedded
 * inside any Farcaster host). The JWT, attached to the Authorization
 * header by FarcasterProvider's fetch wrapper, bypasses cookie policy
 * entirely.
 */
async function getFarcasterAddressFromBearer(req: NextRequest): Promise<string | null> {
  const auth = req.headers.get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice('Bearer '.length).trim()
  if (!token) return null
  const result = await verifyFarcasterJwt(token)
  return result?.address ?? null
}

/**
 * Read the session cookie from a request and return the bound address, or
 * null if missing/expired. This is the single auth check for endpoints that
 * spend platform resources (Arweave credit, sponsored API key) — the
 * httpOnly cookie can't be read by client JS, so XSS can't exfiltrate it.
 *
 * Falls through to a Quick Auth Bearer JWT check when no cookie is
 * present, so Mini App users (whose cookies are blocked by SameSite=Lax
 * inside an iframe) authenticate transparently through the same call.
 */
export async function getSessionAddress(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token) {
    const fromCookie = await verifySession(token)
    if (fromCookie) return fromCookie
  }
  return getFarcasterAddressFromBearer(req)
}

/**
 * Read the session and, if valid, return both the address and the cookie
 * token so the caller can re-stamp the cookie's Max-Age (sliding session).
 * Industry standard: a session that expires at exactly 7 days regardless
 * of activity logs active users out mid-action; refreshing on each
 * authenticated request keeps them signed in as long as they're using
 * the app, while still expiring after 7 days of inactivity.
 *
 * `token` is null when the session came from a Bearer JWT instead of the
 * cookie — there's no opaque token to slide; the JWT carries its own
 * (~1h) expiry and refreshes itself client-side. Callers using the
 * sliding-session pattern should guard `slideSession` on `token != null`.
 */
export async function getSessionContext(
  req: NextRequest,
): Promise<{ address: string; token: string | null } | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (token) {
    const address = await verifySession(token)
    if (address) return { address, token }
  }
  const fromBearer = await getFarcasterAddressFromBearer(req)
  if (fromBearer) return { address: fromBearer, token: null }
  return null
}

/**
 * Slide the session forward by re-stamping the cookie + extending the
 * Redis key TTL on a successful authenticated request. Cheap (1 cookie
 * write + 1 Redis EXPIRE), idempotent across concurrent requests.
 *
 * Accepts `null` as a no-op so callers can pass `ctx.token` from
 * `getSessionContext` without guarding: Bearer-JWT sessions (Mini App
 * users) have no opaque token to slide because the JWT carries its own
 * expiry and refreshes itself client-side.
 */
export async function slideSession(res: NextResponse, token: string | null): Promise<void> {
  if (!token) return
  setSessionCookie(res, token)
  // No context — token is the session identifier itself, don't log it.
  await redis.expire(key(token), SESSION_TTL_SECONDS).catch(bestEffort('session.slide'))
}

/**
 * Set the session cookie on a NextResponse with httpOnly + Secure + SameSite=Lax
 * + Max-Age aligned to SESSION_TTL_SECONDS. Lax (not Strict) so OAuth-style
 * redirect flows still pass through; Strict would also work but breaks bookmarked
 * deep links during a redirect-back.
 */
export function setSessionCookie(res: NextResponse, token: string): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  })
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
}
