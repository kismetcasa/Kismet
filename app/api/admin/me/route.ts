import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { ADMIN_ADDRESS, CURATOR_ADDRESSES } from '@/lib/config'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')?.toLowerCase()
  if (!address || !isAddress(address)) {
    return NextResponse.json({ isAdmin: false, isCurator: false })
  }
  const isAdmin = !!ADMIN_ADDRESS && address === ADMIN_ADDRESS
  const isCurator = CURATOR_ADDRESSES.includes(address)
  return NextResponse.json({ isAdmin, isCurator })
}
