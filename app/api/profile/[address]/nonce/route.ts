import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { createNonce } from '@/lib/profile'

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const nonce = await createNonce(address)
  return NextResponse.json({ nonce })
}
