import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'

const ADMIN_ADDRESS = (process.env.ADMIN_ADDRESS ?? '').toLowerCase()

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()
  if (!address || !isAddress(address)) return NextResponse.json({ isAdmin: false })
  return NextResponse.json({ isAdmin: !!ADMIN_ADDRESS && address === ADMIN_ADDRESS })
}
