import { NextRequest, NextResponse } from 'next/server'
import { verifyTypedData } from 'viem'
import { isAddress } from '@/lib/address'
import { createListing, getListings, getListingForToken, getListingsBySeller } from '@/lib/listings'
import {
  SEAPORT_DOMAIN,
  SEAPORT_ORDER_TYPES,
  deserializeOrder,
  type SerializedOrderComponents,
} from '@/lib/seaport'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1') || 1)
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '18') || 18))
  const collection = searchParams.get('collection') ?? undefined
  const tokenId = searchParams.get('tokenId') ?? undefined
  const seller = searchParams.get('seller') ?? undefined

  if (collection && !isAddress(collection)) {
    return NextResponse.json({ error: 'Invalid collection address' }, { status: 400 })
  }
  if (seller && !isAddress(seller)) {
    return NextResponse.json({ error: 'Invalid seller address' }, { status: 400 })
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
      return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
    }
    if (!tokenId || !seller || !price || !signature || !orderComponents) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
    }
    if (!isAddress(seller)) {
      return NextResponse.json({ error: 'Invalid seller address' }, { status: 400 })
    }
    if (!/^\d+$/.test(tokenId)) {
      return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
    }
    if (BigInt(price) <= 0n) {
      return NextResponse.json({ error: 'Price must be greater than 0' }, { status: 400 })
    }
    if (orderComponents.offerer.toLowerCase() !== seller.toLowerCase()) {
      return NextResponse.json({ error: 'Seller must match order offerer' }, { status: 400 })
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
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
    if (!sigValid) {
      return NextResponse.json({ error: 'Signature does not match seller' }, { status: 401 })
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
    return NextResponse.json({ error: message }, { status })
  }
}
