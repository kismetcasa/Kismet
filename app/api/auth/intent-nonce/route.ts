import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { issueIntentNonce } from '@/lib/intentAuth'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Issues a fresh single-use nonce + expiry for per-action intent signing.
 * Distinct from /api/auth/nonce (which issues SIWE login nonces) so the
 * two key namespaces never collide and a leaked login nonce can't be
 * replayed as an action authorization (or vice versa).
 *
 * Unauthenticated — the nonce is useless without a matching signature
 * from the address claimed in the subsequent body.account / body.sender.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`intent-nonce:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const issued = await issueIntentNonce()
  return NextResponse.json(issued)
}
