import { NextRequest, NextResponse } from 'next/server'
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  verifyTypedData,
} from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { createListing, getListings, getListingForToken, getListingsBySeller } from '@/lib/listings'
import {
  SEAPORT_DOMAIN,
  SEAPORT_ORDER_TYPES,
  EIP2981_ABI,
  deserializeOrder,
  type SerializedOrderComponents,
} from '@/lib/seaport'
import { USDC_BASE } from '@/lib/zoraMint'
import { serverBaseClient } from '@/lib/rpc'
import { errorResponse } from '@/lib/apiResponse'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Validate orderComponents matches what our marketplace assumes: exactly
 *  one ERC-1155 offer item pointing at the listing's collection + tokenId;
 *  consideration items all in the listing's currency (NATIVE+ZERO for ETH,
 *  ERC20+USDC_BASE for USDC); sum of consideration equals declared price;
 *  sane time bounds. Without this, a seller could sign a structurally-
 *  valid Seaport order whose offer points at a different token (buyer
 *  pays for the listed item, gets nothing of value) or whose consideration
 *  is in the wrong token (buyer's fulfill call reverts). */
function validateOrderShape(args: {
  serialized: SerializedOrderComponents
  collectionAddress: string
  tokenId: string
  price: bigint
  currency: 'eth' | 'usdc'
}): { error: string; status: number } | null {
  const { serialized, collectionAddress, tokenId, price, currency } = args

  if (!Array.isArray(serialized.offer) || serialized.offer.length !== 1) {
    return { error: 'Order must offer exactly one item', status: 400 }
  }
  const offer = serialized.offer[0]
  if (offer.itemType !== 3) {
    return { error: 'Offer must be an ERC-1155 item (itemType=3)', status: 400 }
  }
  if (offer.token.toLowerCase() !== collectionAddress.toLowerCase()) {
    return { error: 'Offer token must match listing collectionAddress', status: 400 }
  }
  let offerId: bigint
  try {
    offerId = BigInt(offer.identifierOrCriteria)
  } catch {
    return { error: 'Offer identifierOrCriteria is not a valid integer', status: 400 }
  }
  if (offerId !== BigInt(tokenId)) {
    return { error: 'Offer identifier must match listing tokenId', status: 400 }
  }
  let offerAmount: bigint
  try {
    offerAmount = BigInt(offer.startAmount)
    if (BigInt(offer.endAmount) !== offerAmount) {
      return { error: 'Offer startAmount must equal endAmount (Dutch auctions not supported)', status: 400 }
    }
  } catch {
    return { error: 'Offer amounts are not valid integers', status: 400 }
  }
  if (offerAmount <= 0n) {
    return { error: 'Offer amount must be positive', status: 400 }
  }

  if (!Array.isArray(serialized.consideration) || serialized.consideration.length === 0) {
    return { error: 'Order must have at least one consideration item', status: 400 }
  }
  const expectedItemType = currency === 'usdc' ? 1 : 0
  const expectedToken = currency === 'usdc' ? USDC_BASE.toLowerCase() : ZERO_ADDRESS
  let totalConsideration = 0n
  for (const item of serialized.consideration) {
    if (!isAddress(item.recipient)) {
      // Malformed recipients sign cleanly (the seller signed what they
      // posted) but make the order unfillable — Seaport reverts at fill
      // time trying to send tokens to garbage. Reject up front so the
      // listing doesn't pollute the marketplace and waste a buyer's gas.
      return { error: 'Consideration recipient must be a valid address', status: 400 }
    }
    if (item.itemType !== expectedItemType) {
      return {
        error: `All consideration items must match listing currency (${currency})`,
        status: 400,
      }
    }
    if (item.token.toLowerCase() !== expectedToken) {
      return { error: 'Consideration token does not match listing currency', status: 400 }
    }
    let amount: bigint
    try {
      amount = BigInt(item.startAmount)
      if (BigInt(item.endAmount) !== amount) {
        return { error: 'Consideration startAmount must equal endAmount', status: 400 }
      }
    } catch {
      return { error: 'Consideration amount is not a valid integer', status: 400 }
    }
    if (amount <= 0n) {
      return { error: 'Consideration amounts must be positive', status: 400 }
    }
    totalConsideration += amount
  }
  if (totalConsideration !== price) {
    return { error: 'Sum of consideration must equal declared price', status: 400 }
  }

  let startTime: bigint
  let endTime: bigint
  try {
    startTime = BigInt(serialized.startTime)
    endTime = BigInt(serialized.endTime)
  } catch {
    return { error: 'startTime/endTime are not valid integers', status: 400 }
  }
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (endTime <= now) {
    return { error: 'Order has already expired', status: 400 }
  }
  if (startTime > now + 60n) {
    return { error: 'Order startTime is in the future', status: 400 }
  }
  if (endTime - startTime > 60n * 60n * 24n * 365n) {
    return { error: 'Order lifetime exceeds 1 year', status: 400 }
  }

  return null
}

/** Verify the listing's royalty pays the EIP-2981 receiver in full. Tallies
 *  per-recipient across consideration items 1..N (item 0 is seller proceeds)
 *  so a seller can't put the EIP-2981 receiver in slot 1 with 1 wei and
 *  route 99% of the royalty to a sock-puppet in slot 2 — that would pass a
 *  total-sum check but starve the actual receiver. Collections that don't
 *  implement EIP-2981 must declare zero royalty (no enforceable truth). */
async function verifyRoyalty(args: {
  collection: string
  tokenId: string
  price: bigint
  consideration: SerializedOrderComponents['consideration']
}): Promise<{ error: string; status: number } | null> {
  const { collection, tokenId, price, consideration } = args

  let expectedReceiver: string | null = null
  let expectedAmount = 0n
  let supportsEip2981 = true
  try {
    const [receiver, amount] = (await serverBaseClient().readContract({
      address: collection as `0x${string}`,
      abi: EIP2981_ABI,
      functionName: 'royaltyInfo',
      args: [BigInt(tokenId), price],
    })) as readonly [`0x${string}`, bigint]
    expectedReceiver = receiver.toLowerCase()
    expectedAmount = amount
  } catch (err) {
    // Distinguish contract-side failure (legit "doesn't implement
    // EIP-2981") from transport failure (RPC unreachable AFTER viem's
    // built-in 3-attempt retry). The previous bare catch fell open on
    // both — a transient RPC blip would let a seller list with zero
    // royalty and stiff the EIP-2981 receiver. We fail closed with 503
    // unless we have positive evidence the contract itself errored:
    //   ContractFunctionRevertedError  → contract was reached and
    //     reverted (most commonly: unknown function selector when the
    //     collection doesn't implement royaltyInfo at all).
    //   ContractFunctionZeroDataError  → call returned empty data
    //     (e.g., contract has a fallback that returns nothing).
    // Anything else (HttpRequestError, TimeoutError, RpcRequestError,
    // an unexpected TypeError, etc.) keeps royalty enforcement on.
    const isContractError =
      err instanceof BaseError
      && !!err.walk((e) =>
        e instanceof ContractFunctionRevertedError
        || e instanceof ContractFunctionZeroDataError,
      )
    if (!isContractError) {
      return {
        error: 'Could not verify royalty (RPC unavailable) — try again',
        status: 503,
      }
    }
    supportsEip2981 = false
  }

  const perRecipient = new Map<string, bigint>()
  for (let i = 1; i < consideration.length; i++) {
    const item = consideration[i]
    const r = item.recipient.toLowerCase()
    perRecipient.set(r, (perRecipient.get(r) ?? 0n) + BigInt(item.startAmount))
  }
  const totalRoyalty = Array.from(perRecipient.values()).reduce((a, b) => a + b, 0n)

  if (!supportsEip2981) {
    if (totalRoyalty > 0n) {
      return {
        error: 'Collection does not advertise royalties — listing must declare zero royalty',
        status: 400,
      }
    }
    return null
  }

  if (expectedAmount === 0n) return null

  const toExpected = expectedReceiver ? perRecipient.get(expectedReceiver) ?? 0n : 0n
  if (toExpected < expectedAmount) {
    return {
      error: 'Listing royalty does not pay the collection-advertised receiver in full',
      status: 400,
    }
  }
  return null
}

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

    // Structural validation BEFORE the expensive signature verification —
    // signature recovery would still succeed against a structurally-bogus
    // order (the seller signed exactly what they posted), but buyers would
    // be misled into paying for the wrong asset / in the wrong token.
    const shapeErr = validateOrderShape({
      serialized: orderComponents,
      collectionAddress,
      tokenId,
      price: BigInt(price),
      currency,
    })
    if (shapeErr) return errorResponse(shapeErr.status, shapeErr.error)

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

    // Verify the listing pays the EIP-2981 royalty receiver in full —
    // per-recipient tally across consideration items so a seller can't
    // route most of the royalty to a sock-puppet by giving 1 wei to the
    // legit receiver. Collections without EIP-2981 must declare zero
    // royalty (no on-chain truth to compare against).
    const royaltyErr = await verifyRoyalty({
      collection: collectionAddress,
      tokenId,
      price: BigInt(price),
      consideration: orderComponents.consideration,
    })
    if (royaltyErr) return errorResponse(royaltyErr.status, royaltyErr.error)

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
