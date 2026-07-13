import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { redis } from '@/lib/redis'
import { ADMIN_SESSION_COOKIE, adminSessionKey } from '@/lib/curator'

/**
 * Revoke the caller's admin session. Deletes the token from Redis (so any
 * lingering cookie copies stop working) and clears the cookie on the
 * response. Safe to call without a session — succeeds idempotently.
 */
export async function POST() {
  const cookieStore = await cookies()
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value
  if (token) {
    await redis.del(adminSessionKey(token)).catch(() => {})
  }
  const res = NextResponse.json({ ok: true })
  // Clear with explicit attributes: a `__Host-`-prefixed cookie is only
  // overwritten by a Set-Cookie that itself satisfies Secure + Path=/.
  res.cookies.set(ADMIN_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  })
  return res
}
