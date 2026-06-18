import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { authorizeProfileOwner } from '@/lib/profileOwner'
import { setEarningsPublic } from '@/lib/earningsVisibility'
import { errorResponse } from '@/lib/apiResponse'

// Owner toggle for public earnings visibility (POST = public, DELETE = private).
// Session-cookie auth + canonical match, same model as the pins route.
async function toggle(req: NextRequest, address: string, isPublic: boolean) {
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  await setEarningsPublic(auth.canonical, isPublic)
  return NextResponse.json({ public: isPublic })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  return toggle(req, (await params).address, true)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ address: string }> }) {
  return toggle(req, (await params).address, false)
}
