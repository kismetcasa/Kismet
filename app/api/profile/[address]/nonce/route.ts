import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { createNonce } from '@/lib/profile'
import { errorResponse, upstreamError } from '@/lib/apiResponse'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`nonce:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const { address } = await params
  if (!isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  // createNonce is a Redis write with no internal guard; since the 5→2 retry
  // cap (1bf7b1b) a transient Upstash blip surfaces here in ~300ms. Fail as a
  // clean retryable 503 instead of an unhandled 500 — same wrap-the-Redis-write
  // pattern as agent/prepare-mint's issueIntentNonce call. (checkRateLimit
  // above already fails open; this was the one fail-closed leg on the route.)
  try {
    const nonce = await createNonce(address)
    return NextResponse.json({ nonce })
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — please retry', err, 'profile-nonce')
  }
}
