import { redis } from './redis'
import { randomUUID } from 'crypto'
import type { NextRequest, NextResponse } from 'next/server'

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

// `__Host-` prefix is browser-enforced cookie integrity: the browser only
// accepts cookies with this prefix when they are also Secure, Path=/, and
// have NO Domain attribute set. This blocks subdomain-based cookie
// confusion attacks (an attacker on attacker.kismet-art.vercel.app can't
// set a cookie that overrides ours). Requires HTTPS — so we only apply
// the prefix in production. Dev (localhost http) keeps the plain name.
export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production'
    ? '__Host-kismet_session'
    : 'kismet_session'

const key = (token: string) => `kismetart:session:${token}`

export async function createSession(address: string): Promise<string> {
  const token = randomUUID()
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
 * Read the session cookie from a request and return the bound address, or
 * null if missing/expired. This is the single auth check for endpoints that
 * spend platform resources (Arweave credit, sponsored API key) — the
 * httpOnly cookie can't be read by client JS, so XSS can't exfiltrate it.
 */
export async function getSessionAddress(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  return verifySession(token)
}

/**
 * Read the session and, if valid, return both the address and the cookie
 * token so the caller can re-stamp the cookie's Max-Age (sliding session).
 * Industry standard: a session that expires at exactly 7 days regardless
 * of activity logs active users out mid-action; refreshing on each
 * authenticated request keeps them signed in as long as they're using
 * the app, while still expiring after 7 days of inactivity.
 */
export async function getSessionContext(req: NextRequest): Promise<{ address: string; token: string } | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const address = await verifySession(token)
  if (!address) return null
  return { address, token }
}

/**
 * Slide the session forward by re-stamping the cookie + extending the
 * Redis key TTL on a successful authenticated request. Cheap (1 cookie
 * write + 1 Redis EXPIRE), idempotent across concurrent requests.
 */
export async function slideSession(res: NextResponse, token: string): Promise<void> {
  setSessionCookie(res, token)
  await redis.expire(key(token), SESSION_TTL_SECONDS).catch(() => {})
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
