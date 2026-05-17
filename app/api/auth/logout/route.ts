import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { redis } from '@/lib/redis'
import { ADMIN_SESSION_COOKIE } from '@/lib/curator'

/**
 * Revoke the caller's admin session. Deletes the token from Redis (so any
 * lingering cookie copies stop working) and clears the cookie on the
 * response. Safe to call without a session — succeeds idempotently.
 */
export async function POST() {
  const cookieStore = await cookies()
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value
  if (token) {
    await redis.del(`kismetart:auth-session:${token}`).catch(() => {})
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(ADMIN_SESSION_COOKIE)
  return res
}
