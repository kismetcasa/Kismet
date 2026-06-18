import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { authorizeProfileOwner } from '@/lib/profileOwner'
import { isEarningsPublic, setEarningsPublic } from '@/lib/earningsVisibility'
import { errorResponse } from '@/lib/apiResponse'

// Owner toggle for public earnings visibility. Same model as the pins route:
// session-cookie auth + canonical-address match (one tap, no signature).
//   GET    → current visibility (public). Public read.
//   POST   → make earnings public.
//   DELETE → make earnings private.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  return NextResponse.json({ public: await isEarningsPublic(address) })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  await setEarningsPublic(auth.canonical, true)
  return NextResponse.json({ public: true })
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  const { address } = await params
  if (!isAddress(address)) return errorResponse(400, 'Invalid address')
  const auth = await authorizeProfileOwner(req, address)
  if ('error' in auth) return errorResponse(auth.status, auth.error)
  await setEarningsPublic(auth.canonical, false)
  return NextResponse.json({ public: false })
}
