import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { createNonce } from '@/lib/profile'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`nonce:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const nonce = await createNonce(address)
  return NextResponse.json({ nonce })
}
