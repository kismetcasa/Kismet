import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { createNonce } from '@/lib/profile'
import { errorResponse } from '@/lib/apiResponse'

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
  const nonce = await createNonce(address)
  return NextResponse.json({ nonce })
}
