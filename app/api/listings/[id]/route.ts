import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { getListing, updateListingStatus } from '@/lib/listings'
import { consumeNonce } from '@/lib/profile'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { writeNotification } from '@/lib/notifications'
import { errorResponse } from '@/lib/apiResponse'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`listings-patch:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const { id } = await params
  const body = await req.json() as {
    status: string
    signature?: string
    nonce?: string
    signer?: string
  }

  if (body.status !== 'filled' && body.status !== 'cancelled') {
    return errorResponse(400, 'status must be filled or cancelled')
  }

  const listing = await getListing(id)
  if (!listing) {
    return errorResponse(404, 'Listing not found')
  }
  if (listing.status !== 'active') {
    return errorResponse(409, 'Listing is already inactive')
  }

  // Both branches require a signed message tied to the listing id + signer +
  // nonce. The cancel branch must be from the seller; the filled branch must
  // be from someone other than the seller (anti-self-mark, since legit buyers
  // can't be the seller per fulfillOrder semantics).
  const { signature, nonce, signer } = body
  if (!signature || !nonce || !signer || !isAddress(signer)) {
    return errorResponse(400, 'signature, nonce, and signer required')
  }

  if (body.status === 'cancelled') {
    if (signer.toLowerCase() !== listing.seller.toLowerCase()) {
      return errorResponse(403, 'Only the seller can cancel this listing')
    }
    const message = `Cancel Kismet Art listing\nListing: ${id}\nSeller: ${signer.toLowerCase()}\nNonce: ${nonce}`
    const verified = await verifyMessage({
      address: signer as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    if (!verified) {
      return errorResponse(401, 'Signature verification failed')
    }
    const valid = await consumeNonce(signer, nonce)
    if (!valid) {
      return errorResponse(401, 'Invalid or expired nonce')
    }
  } else {
    // status === 'filled' — must be the buyer.
    if (signer.toLowerCase() === listing.seller.toLowerCase()) {
      return errorResponse(403, 'Seller cannot mark own listing filled')
    }
    const message = `Mark Kismet Art listing filled\nListing: ${id}\nBuyer: ${signer.toLowerCase()}\nNonce: ${nonce}`
    const verified = await verifyMessage({
      address: signer as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
    if (!verified) {
      return errorResponse(401, 'Signature verification failed')
    }
    const valid = await consumeNonce(signer, nonce)
    if (!valid) {
      return errorResponse(401, 'Invalid or expired nonce')
    }
  }

  await updateListingStatus(id, body.status as 'filled' | 'cancelled')

  if (body.status === 'filled') {
    after(() =>
      writeNotification({
        type: 'sale',
        recipient: listing.seller,
        actor: signer.toLowerCase(),
        tokenAddress: listing.collectionAddress,
        tokenId: listing.tokenId,
        tokenName: listing.name,
        tokenImage: listing.image,
        price: listing.price,
        // Without currency, NotificationRow defaults to ETH formatting and
        // would render a USDC sale's price (in 6dp base units) as a tiny ETH
        // amount. Pass it through so $5 stays $5.
        currency: listing.currency,
        listingId: listing.id,
      }),
    )
  }

  return NextResponse.json({ ok: true })
}
