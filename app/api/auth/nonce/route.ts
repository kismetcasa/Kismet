import { NextRequest, NextResponse } from 'next/server'
import { randomHex } from '@/lib/random'
import { redis } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { adminNonceKey } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

// 5 minutes is long enough for any reasonable wallet signing flow and
// short enough that a leaked nonce can't be exploited later. Nonces are
// 128 bits of randomness — unbruteforceable.
const NONCE_TTL_SECONDS = 5 * 60

/**
 * Issues a single-use nonce for SIWE login. The nonce is stored in Redis
 * with a 5-minute TTL; the /api/auth/login endpoint consumes it atomically
 * after signature verification. Rate-limited per-IP to make grinding for
 * collisions or DoS-ing the keyspace impractical.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`auth-nonce:${ip}`, 30, 60)
  if (!allowed) {
    return errorResponse(429, 'Too many requests')
  }

  const nonce = randomHex(16)
  await redis.set(adminNonceKey(nonce), '1', {
    nx: true,
    ex: NONCE_TTL_SECONDS,
  })
  return NextResponse.json({ nonce })
}
