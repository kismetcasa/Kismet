import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage, isAddress } from 'viem'
import { getListing, updateListingStatus } from '@/lib/listings'
import { consumeNonce } from '@/lib/profile'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`listings-patch:${ip}`, 20, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const { id } = await params
  const body = await req.json() as {
    status: string
    signature?: string
    nonce?: string
    signer?: string
  }

  if (body.status !== 'filled' && body.status !== 'cancelled') {
    return NextResponse.json({ error: 'status must be filled or cancelled' }, { status: 400 })
  }

  const listing = await getListing(id)
  if (!listing) {
    return NextResponse.json({ error: 'Listing not found' }, { status: 404 })
  }
  if (listing.status !== 'active') {
    return NextResponse.json({ error: 'Listing is already inactive' }, { status: 409 })
  }

  // Cancel requires a signed message from the seller
  if (body.status === 'cancelled') {
    const { signature, nonce, signer } = body
    if (!signature || !nonce || !signer) {
      return NextResponse.json({ error: 'signature, nonce, and signer required to cancel' }, { status: 400 })
    }
    if (!isAddress(signer)) {
      return NextResponse.json({ error: 'Invalid signer address' }, { status: 400 })
    }
    if (signer.toLowerCase() !== listing.seller.toLowerCase()) {
      return NextResponse.json({ error: 'Only the seller can cancel this listing' }, { status: 403 })
    }
    const valid = await consumeNonce(signer, nonce)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
    }
    const message = `Cancel Kismet Art listing\nListing: ${id}\nSeller: ${signer.toLowerCase()}\nNonce: ${nonce}`
    const verified = await verifyMessage({
      address: signer as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    if (!verified) {
      return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })
    }
  }

  await updateListingStatus(id, body.status as 'filled' | 'cancelled')
  return NextResponse.json({ ok: true })
}
