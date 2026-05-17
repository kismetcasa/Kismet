import { NextRequest, NextResponse } from 'next/server'
import { verifyTypedData } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { createListing, getListings, getListingForToken, getListingsBySeller } from '@/lib/listings'
import {
  SEAPORT_DOMAIN,
  SEAPORT_ORDER_TYPES,
  deserializeOrder,
  type SerializedOrderComponents,
} from '@/lib/seaport'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1') || 1)
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '18') || 18))
  const collection = searchParams.get('collection') ?? undefined
  const tokenId = searchParams.get('tokenId') ?? undefined
  const seller = searchParams.get('seller') ?? undefined

  if (collection && !isAddress(collection)) {
    return errorResponse(400, 'Invalid collection address')
  }
  if (seller && !isAddress(seller)) {
    return errorResponse(400, 'Invalid seller address')
  }

  // Single-token lookup — requires seller to identify which listing
  if (collection && tokenId && seller) {
    const listing = await getListingForToken(collection, tokenId, seller)
    return NextResponse.json({ listing: listing ?? null })
  }

  // Seller profile lookup — all active listings by a specific seller
  if (seller && !collection && !tokenId) {
    const listings = await getListingsBySeller(seller)
    return NextResponse.json({ listings, pagination: { page: 1, limit: listings.length, total: listings.length, total_pages: 1 } })
  }

  const { listings, total } = await getListings({ page, limit, collection })
  return NextResponse.json({
    listings,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    },
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      collectionAddress: string
      tokenId: string
      seller: string
      price: string
      sellerProceeds: string
      royaltyReceiver: string
      royaltyAmount: string
      currency?: 'eth' | 'usdc'
      orderComponents: SerializedOrderComponents
      signature: string
      expiresAt: number
      name?: string
      image?: string
      creatorAddress?: string
      contentUri?: string
      contentMime?: string
    }

    const {
      collectionAddress, tokenId, seller, price,
      sellerProceeds, royaltyReceiver, royaltyAmount,
      orderComponents, signature, expiresAt,
    } = body
    const currency: 'eth' | 'usdc' = body.currency === 'usdc' ? 'usdc' : 'eth'

    if (!isAddress(collectionAddress)) {
      return errorResponse(400, 'Invalid collectionAddress')
    }
    if (!tokenId || !seller || !price || !signature || !orderComponents) {
      return errorResponse(400, 'Missing required fields')
    }
    if (!isAddress(seller)) {
      return errorResponse(400, 'Invalid seller address')
    }
    if (!isValidTokenId(tokenId)) {
      return errorResponse(400, 'Invalid tokenId')
    }
    if (BigInt(price) <= 0n) {
      return errorResponse(400, 'Price must be greater than 0')
    }
    if (orderComponents.offerer.toLowerCase() !== seller.toLowerCase()) {
      return errorResponse(400, 'Seller must match order offerer')
    }

    // Verify the EIP-712 signature is from the offerer. Without this anyone
    // could spam-list tokens they don't own (Seaport reverts at fill time,
    // but the listing pollutes the marketplace until then).
    const order = deserializeOrder(orderComponents)
    let sigValid = false
    try {
      sigValid = await verifyTypedData({
        address: seller as `0x${string}`,
        domain: SEAPORT_DOMAIN,
        types: SEAPORT_ORDER_TYPES,
        primaryType: 'OrderComponents',
        message: {
          offerer: order.offerer,
          zone: order.zone,
          offer: order.offer,
          consideration: order.consideration,
          orderType: order.orderType,
          startTime: order.startTime,
          endTime: order.endTime,
          zoneHash: order.zoneHash,
          salt: order.salt,
          conduitKey: order.conduitKey,
          counter: order.counter,
        },
        signature: signature as `0x${string}`,
      })
    } catch {
      return errorResponse(401, 'Invalid signature')
    }
    if (!sigValid) {
      return errorResponse(401, 'Signature does not match seller')
    }

    const listing = await createListing({
      collectionAddress,
      tokenId,
      seller,
      price,
      sellerProceeds,
      royaltyReceiver,
      royaltyAmount,
      currency,
      orderComponents,
      signature,
      expiresAt,
      name: body.name,
      image: body.image,
      creatorAddress: body.creatorAddress,
      contentUri: body.contentUri,
      contentMime: body.contentMime,
    })

    return NextResponse.json({ listing }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create listing'
    const status = message.includes('already exists') ? 409 : 500
    return errorResponse(status, message)
  }
}
