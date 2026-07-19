import { NextRequest, NextResponse } from 'next/server'
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  parseErc6492Signature,
  parseUnits,
  type Address,
} from 'viem'
import { resolveOnchainSale } from '@/lib/saleConfig'
import { isAddress, isValidTokenId } from '@/lib/address'
import { isBlacklisted } from '@/lib/blacklist'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getListingVisibility } from '@/lib/hiddenListings'
import { getSessionAddress } from '@/lib/session'
import { createListing, getListings, getActiveListingSnapshot, getListingForToken, getListingsBySeller } from '@/lib/listings'
import {
  SEAPORT_DOMAIN,
  SEAPORT_ORDER_TYPES,
  EIP2981_ABI,
  ERC1155_ABI,
  deserializeOrder,
  type SerializedOrderComponents,
} from '@/lib/seaport'
import { USDC_BASE } from '@/lib/zoraMint'
import { PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS, computePlatformFee, isBelowListingFloor } from '@/lib/platformFee'
import { serverBaseClient } from '@/lib/rpc'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getGateConfig } from '@/lib/gate'
import { markKismetListed } from '@/lib/pass-validity'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = '0x' + '0'.repeat(64)

// "Expiring soon" browse-filter window. 48h matches the urgency framing on
// the discover ovals ("expires 2d") — long enough to act on, short enough
// to mean something.
const EXPIRING_SOON_MS = 48 * 60 * 60 * 1000

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

  // Pin Seaport's routing/validator slots to "no zone, no conduit". Kismet's
  // marketplace builds zoneless conduit-less orders exclusively (lib/seaport.ts
  // uses ZERO_ADDRESS / ZERO_BYTES32 here). Anything else means the seller
  // signed an order that routes through an unknown zone validator or a Conduit
  // we don't support — the signature is valid (the seller authorized those
  // bytes) but the order would either revert at fulfillment time or get the
  // buyer's call delegated through an unintended contract. Reject up front.
  if (serialized.zone.toLowerCase() !== ZERO_ADDRESS) {
    return { error: 'Order zone must be the zero address', status: 400 }
  }
  if (serialized.conduitKey.toLowerCase() !== ZERO_BYTES32) {
    return { error: 'Order conduitKey must be zero', status: 400 }
  }

  if (!Array.isArray(serialized.consideration) || serialized.consideration.length === 0) {
    return { error: 'Order must have at least one consideration item', status: 400 }
  }
  // Cap consideration length before any iteration — a 1M-item array would
  // exhaust CPU in every downstream loop (validateOrderShape, verifyPlatformFee,
  // verifyRoyalty) and is never legitimate. Normal listings have 2–3 items.
  if (serialized.consideration.length > 5) {
    return { error: 'Too many consideration items (max 5)', status: 400 }
  }
  // Consideration[0] must go to the seller (their proceeds). buildSellOrder always
  // constructs it this way. Validating it here prevents a misconfigured or
  // hand-crafted order from routing seller proceeds to an arbitrary address while
  // still passing the fee and royalty checks that tally from index 1 onward.
  if (serialized.consideration[0].recipient.toLowerCase() !== serialized.offerer.toLowerCase()) {
    return { error: 'First consideration item must go to the seller', status: 400 }
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
    // identifierOrCriteria is only meaningful for ERC721/ERC1155 offer items.
    // For NATIVE and ERC20 consideration items it must be zero — a non-zero value
    // signals a criteria-based order that Seaport handles differently and that
    // our marketplace does not support.
    let identifierOrCriteria: bigint
    try {
      identifierOrCriteria = BigInt(item.identifierOrCriteria)
    } catch {
      return { error: 'Consideration identifierOrCriteria is not a valid integer', status: 400 }
    }
    if (identifierOrCriteria !== 0n) {
      return { error: 'Consideration identifierOrCriteria must be zero', status: 400 }
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

// Verify the listing's consideration includes the required 1% platform fee to
// PLATFORM_FEE_RECIPIENT. Per-recipient tally across items 1..N (item 0 is
// seller); minimum-not-exact so rounding tolerance matches seaport-order-validator,
// while validateOrderShape's strict sum ensures no value is invented.
function verifyPlatformFee(args: {
  price: bigint
  consideration: SerializedOrderComponents['consideration']
}): { error: string; status: number } | null {
  const { price, consideration } = args
  const expectedFee = computePlatformFee(price)
  const perRecipient = new Map<string, bigint>()
  for (let i = 1; i < consideration.length; i++) {
    const item = consideration[i]
    const r = item.recipient.toLowerCase()
    perRecipient.set(r, (perRecipient.get(r) ?? 0n) + BigInt(item.startAmount))
  }
  const toFeeRecipient = perRecipient.get(PLATFORM_FEE_RECIPIENT.toLowerCase()) ?? 0n
  if (toFeeRecipient < expectedFee) {
    return {
      error: `Listing must include a ${PLATFORM_FEE_BPS} bps (1%) platform fee`,
      status: 400,
    }
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
  // Deduct the platform fee from the tally so it is not counted as royalty.
  // Without this, two problems arise:
  //   (1) Non-EIP-2981 collections: the fee item makes totalRoyalty > 0 and
  //       triggers the "must declare zero royalty" rejection for every listing.
  //   (2) EIP-2981 + feeRecipient == royaltyReceiver: the fee item satisfies
  //       the royalty minimum check even when no royalty item is present,
  //       letting a seller pocket the royalty by omitting it from consideration.
  const expectedPlatformFee = computePlatformFee(price)
  if (expectedPlatformFee > 0n) {
    const feeKey = PLATFORM_FEE_RECIPIENT.toLowerCase()
    const current = perRecipient.get(feeKey) ?? 0n
    perRecipient.set(feeKey, current > expectedPlatformFee ? current - expectedPlatformFee : 0n)
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

  // Cross-market bridge: just the visible active listings' "collection:tokenId"
  // keys (duplicates = one per live listing), so the discover primary ovals can
  // mark "N resale" from ONE bounded request instead of paginating the whole
  // book. Identical for every viewer → safe for the same short shared-cache
  // window the timeline uses.
  if (searchParams.get('keys') === '1') {
    return NextResponse.json(
      await getActiveListingSnapshot(),
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } },
    )
  }

  // ── Browse filters (marketplace feed only — the single-token and
  // seller-scope branches below ignore them). Validated fail-closed: a
  // malformed value is a 400, never a silently unfiltered feed. ──
  const rawCurrency = searchParams.get('currency')
  if (rawCurrency !== null && rawCurrency !== 'eth' && rawCurrency !== 'usdc') {
    return errorResponse(400, 'Invalid currency')
  }
  const currency = (rawCurrency as 'eth' | 'usdc' | null) ?? undefined
  const DECIMAL = /^\d+(\.\d{1,18})?$/
  const priceMinRaw = searchParams.get('price_min')
  const priceMaxRaw = searchParams.get('price_max')
  if ((priceMinRaw !== null && !DECIMAL.test(priceMinRaw)) || (priceMaxRaw !== null && !DECIMAL.test(priceMaxRaw))) {
    return errorResponse(400, 'Invalid price bound')
  }
  // A base-units range is meaningless across two denominations (wei vs 6dp),
  // so a price bound requires the currency to be pinned.
  if ((priceMinRaw !== null || priceMaxRaw !== null) && !currency) {
    return errorResponse(400, 'Price filter requires currency')
  }
  // parseUnits throws when the decimal has more places than the currency
  // carries (e.g. 7dp against USDC's 6) — surface that as a 400, not a 500.
  const decimals = currency === 'usdc' ? 6 : 18
  let priceMin: bigint | undefined
  let priceMax: bigint | undefined
  try {
    priceMin = priceMinRaw !== null ? parseUnits(priceMinRaw, decimals) : undefined
    priceMax = priceMaxRaw !== null ? parseUnits(priceMaxRaw, decimals) : undefined
  } catch {
    return errorResponse(400, 'Invalid price bound')
  }
  const expiring = searchParams.get('expiring') === '1'
  const belowMint = searchParams.get('below') === '1'
  // Only 'artist' exists: the UI pill is a boolean and nothing sends 'resale',
  // so the value would be dead API surface (line-audit finding).
  const rawSellerType = searchParams.get('seller_type')
  if (rawSellerType !== null && rawSellerType !== 'artist') {
    return errorResponse(400, 'Invalid seller_type')
  }
  const sellerType = (rawSellerType as 'artist' | null) ?? undefined
  const royaltyMinRaw = searchParams.get('royalty_min')
  if (royaltyMinRaw !== null && !(DECIMAL.test(royaltyMinRaw) && Number(royaltyMinRaw) <= 100)) {
    return errorResponse(400, 'Invalid royalty_min')
  }
  const royaltyMinBps = royaltyMinRaw !== null ? Math.round(Number(royaltyMinRaw) * 100) : undefined
  const rawSort = searchParams.get('sort')
  if (rawSort !== null && rawSort !== 'price-asc' && rawSort !== 'price-desc' && rawSort !== 'expiring') {
    return errorResponse(400, 'Invalid sort')
  }
  const sort = (rawSort as 'price-asc' | 'price-desc' | 'expiring' | null) ?? undefined

  const visibility = await getListingVisibility()

  // Single-token lookup — direct deeplink. Author-level (hidden-user)
  // filtering is deliberately NOT applied here, matching the single-
  // collection lookup precedent in /api/collections (BuyButton needs to
  // resolve a known listing to fulfill). Content-level hides DO apply:
  // an admin-hidden listing — or a listing whose moment or collection is
  // hidden — is off the market entirely, deeplink included — EXCEPT for
  // the authenticated seller themselves, who can still resolve their own
  // hidden listing (same own-content exception as the seller-scope branch,
  // so a client driving cancel from this lookup doesn't show "not listed"
  // while re-listing 409s on the still-occupied slot). Session read is
  // gated behind the hidden case so the common path stays cookie-free.
  if (collection && tokenId && seller) {
    const listing = await getListingForToken(collection, tokenId, seller)
    let visible = !!listing && !visibility.contentHidden(listing)
    if (listing && !visible) {
      const viewer = await getSessionAddress(req)
      visible = viewer?.toLowerCase() === listing.seller.toLowerCase()
    }
    return NextResponse.json({ listing: visible ? listing : null })
  }

  // Seller-scope lookup. Third parties get an empty list when the seller
  // is admin-hidden (don't leak "this user exists but is hidden") and
  // never see hidden listings. The seller sees their own list unfiltered —
  // including admin-hidden entries — so they can still cancel them: the
  // same own-content exception the timeline applies to hidden moments,
  // authenticated by the session cookie / Farcaster bearer.
  if (seller && !collection && !tokenId) {
    const [hiddenUsers, viewer] = await Promise.all([
      getHiddenUsersSet(),
      getSessionAddress(req),
    ])
    const isOwnView = viewer?.toLowerCase() === seller.toLowerCase()
    if (!isOwnView && hiddenUsers.has(seller.toLowerCase())) {
      return NextResponse.json({ listings: [], pagination: { page: 1, limit: 0, total: 0, total_pages: 1 } })
    }
    const all = await getListingsBySeller(seller)
    const listings = isOwnView ? all : all.filter((l) => !visibility.feedHidden(l))
    return NextResponse.json({ listings, pagination: { page: 1, limit: listings.length, total: listings.length, total_pages: 1 } })
  }

  const { listings, total } = await getListings({
    page,
    limit,
    collection,
    filters: {
      currency,
      priceMin,
      priceMax,
      ...(expiring ? { expiringWithinMs: EXPIRING_SOON_MS } : {}),
      ...(belowMint ? { belowMint: true } : {}),
      sellerType,
      royaltyMinBps,
      sort,
    },
  })
  // Filter post-pagination; the store isn't indexed by visibility, so
  // `total` may overcount hidden listings on this page. Acceptable for
  // the marketplace feed. feedHidden covers the per-listing hide, the
  // hidden-moment/collection cascade, and hidden sellers/creators.
  const visibleListings = listings.filter((l) => !visibility.feedHidden(l))
  return NextResponse.json({
    listings: visibleListings,
    pagination: {
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    },
  })
}

export async function POST(req: NextRequest) {
  // Listing creation does EIP-712 signature recovery + on-chain royalty reads
  // + Redis writes per call; cap per-IP so it can't be spammed. The signature
  // + blacklist checks below gate WHO can list; this gates the rate.
  if (!(await checkRateLimit(`listings-post:${getClientIp(req)}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }
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
      expiresAt?: number
      name?: string
      image?: string
      creatorAddress?: string
      contentUri?: string
      contentMime?: string
    }

    const {
      collectionAddress, tokenId, seller, price,
      sellerProceeds, royaltyReceiver, royaltyAmount,
      orderComponents, signature,
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
    // Canonical decimal form at the trust boundary. isValidTokenId accepts
    // leading zeros while every on-chain check below compares via BigInt —
    // so '01' would otherwise store a listing in a SEPARATE owned slot from
    // '1' (bypassing the one-active-listing invariant) whose raw tokenId
    // also evades the hidden-moment cascade and the admin dashboard's
    // per-listing tooling. Normalize once; everything downstream (storage,
    // slot key, hide keys) uses the canonical form.
    const canonicalTokenId = BigInt(tokenId).toString()
    if (BigInt(price) <= 0n) {
      return errorResponse(400, 'Price must be greater than 0')
    }
    // Guard against fee-recipient misconfiguration — zero address silently burns
    // all fee revenue; a malformed address means verifyPlatformFee's Map lookup
    // would never match. Catches both before any RPC is spent.
    if (!isAddress(PLATFORM_FEE_RECIPIENT) || PLATFORM_FEE_RECIPIENT.toLowerCase() === ZERO_ADDRESS) {
      return errorResponse(500, 'Platform fee recipient misconfigured')
    }
    // Reject prices whose 1% fee floors to zero (the dust bypass). isBelowListingFloor
    // is the shared rule (lib/platformFee) the web ListButton + agent prepare-list
    // also enforce, so a client can't build/sign an order this route then rejects.
    if (isBelowListingFloor(BigInt(price))) {
      return errorResponse(400, 'Price is below the minimum listing price')
    }
    // Needed for the sum invariant + stored record below.
    const platformFeeBig = computePlatformFee(BigInt(price))
    // The top-level royaltyReceiver/royaltyAmount aren't enforced on-chain
    // (Seaport pays whatever the consideration items declare; verifyRoyalty
    // below enforces the EIP-2981 receiver), but they're persisted on the
    // listing record and rendered in the UI. Reject malformed values up
    // front so we don't store "0xfffff" or "not-a-number" as display data.
    if (!isAddress(royaltyReceiver)) {
      return errorResponse(400, 'Invalid royaltyReceiver address')
    }
    let royaltyAmountBig: bigint
    try {
      royaltyAmountBig = BigInt(royaltyAmount)
    } catch {
      return errorResponse(400, 'royaltyAmount is not a valid integer')
    }
    if (royaltyAmountBig < 0n || royaltyAmountBig > BigInt(price)) {
      return errorResponse(400, 'royaltyAmount must be 0 ≤ amount ≤ price')
    }
    let sellerProceedsBig: bigint
    try {
      sellerProceedsBig = BigInt(sellerProceeds)
    } catch {
      return errorResponse(400, 'sellerProceeds is not a valid integer')
    }
    if (sellerProceedsBig < 0n || sellerProceedsBig + platformFeeBig + royaltyAmountBig !== BigInt(price)) {
      return errorResponse(400, 'sellerProceeds + platformFee + royaltyAmount must equal price')
    }
    if (orderComponents.offerer.toLowerCase() !== seller.toLowerCase()) {
      return errorResponse(400, 'Seller must match order offerer')
    }

    // Action-blacklist gate: blocks the seller from creating new listings
    // on the platform. Their existing listings and on-chain ownership are
    // unaffected. Symmetric with the gate in lib/mint-proxy (mint/write)
    // and /api/airdrop/notify — anything that produces new content for
    // the marketplace consults this list.
    if (await isBlacklisted(seller)) {
      return errorResponse(403, 'Address is blocked from listing')
    }
    // Per-seller rate limit: a single wallet can't spam listings even across
    // multiple IPs. The per-IP gate above limits infrastructure abuse; this
    // limits wallet-level abuse. 5 listings/60s is generous for legitimate use.
    if (!(await checkRateLimit(`listings-post-seller:${seller.toLowerCase()}`, 5, 60))) {
      return errorResponse(429, 'Too many requests')
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

    // Cross-validate submitted sellerProceeds against the signed consideration[0].
    // The sum invariant above confirms sellerProceeds + fee + royalty === price;
    // this confirms the DB display field matches what the seller actually signed
    // (consideration[0].startAmount). Without it a client could set sellerProceeds
    // to an arbitrary value that misleads the UI while the on-chain split differs.
    if (sellerProceedsBig !== BigInt(orderComponents.consideration[0].startAmount)) {
      return errorResponse(400, 'sellerProceeds does not match signed order')
    }

    // Verify the platform fee before the expensive signature RPC — pure local
    // check, no reason to burn an RPC call on a fee-less order.
    const feeErr = verifyPlatformFee({ price: BigInt(price), consideration: orderComponents.consideration })
    if (feeErr) return errorResponse(feeErr.status, feeErr.error)

    // Verify the seller holds the token before accepting — prevents order-book
    // pollution with structurally-valid but unfillable orders. Without this gate,
    // any wallet can sign and post listings for tokens it doesn't hold; Seaport
    // reverts at fill time, but the listing pollutes the feed for up to 30 days
    // and wastes buyer gas on doomed transactions. TOCTOU note: a seller can
    // transfer away after this check — the on-chain revert is the final authority.
    // Fails closed (502) on RPC error, consistent with verifyRoyalty below.
    try {
      const bal = await serverBaseClient().readContract({
        address: collectionAddress as `0x${string}`,
        abi: ERC1155_ABI,
        functionName: 'balanceOf',
        args: [seller as `0x${string}`, BigInt(tokenId)],
      }) as bigint
      if (bal <= 0n) {
        return errorResponse(403, 'Seller does not hold this token')
      }
      // Also reject an order offering MORE editions than the seller holds:
      // structurally unfillable (Seaport reverts at fill), so it only pollutes
      // the feed and wastes buyer gas — the same class the balance gate above
      // exists to prevent. offer[0] was validated to exist by validateOrderShape.
      const offeredAmount = BigInt(orderComponents.offer[0]?.startAmount ?? 0)
      if (offeredAmount > bal) {
        return errorResponse(403, 'Listing offers more editions than you hold')
      }
    } catch {
      return errorResponse(502, 'Could not verify token ownership — try again')
    }

    // Verify the EIP-712 signature is from the offerer. Without this anyone
    // could spam-list tokens they don't own (Seaport reverts at fill time,
    // but the listing pollutes the marketplace until then).
    //
    // Use the CLIENT verifyTypedData (not viem's offline util) so EOA, ERC-1271
    // smart-wallet, and ERC-6492 (counterfactual/undeployed Base Account)
    // signatures all validate — the offline util does ECDSA-only and would 401
    // every smart-wallet seller. Mirrors lib/intentAuth.ts / lib/siweLogin.ts.
    const order = deserializeOrder(orderComponents)
    let sigValid = false
    try {
      sigValid = await serverBaseClient().verifyTypedData({
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

    // De-wrap an ERC-6492 signature before storing it. A smart-wallet seller
    // whose account isn't yet deployed signs with a 6492 wrapper (factory +
    // deploy calldata + inner sig); Seaport's on-chain EIP-1271 check can't
    // process the wrapper, so persist the INNER signature (a no-op for plain
    // EOA/1271 sigs). The order becomes fillable once the account is deployed
    // (the seller's first on-chain tx); until then it's no worse than before.
    const { signature: onchainSignature } = parseErc6492Signature(signature as `0x${string}`)

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

    // Derive expiry from the signed order — don't trust client-submitted value.
    // A client can't set expiresAt past endTime to keep a stale listing visible
    // in the feed after the Seaport order is no longer fillable on-chain.
    // validateOrderShape already validated endTime is in range (not expired,
    // within 1 year), so Number() is safe — endTime << 2^53.
    const expiresAt = Number(BigInt(orderComponents.endTime)) * 1000

    // Mint-price snapshot for the below-mint browse filter — read from CHAIN,
    // server-side, so it can't be forged (a client-supplied value would let a
    // lister buy the deal signal with a fake high mint price). Non-blocking:
    // an RPC blip skips the snapshot, never the listing (such rows simply
    // never match below=1 — fail-closed). Skipped when the mint sale is
    // scheduled or ended: a price nobody can pay isn't a comparison baseline.
    // Display badges keep using the LIVE dwell-gated read (authoritative);
    // this snapshot only powers the server filter, so the two can drift if
    // the artist reprices the mint after listing — documented trade.
    let mintPrice: string | undefined
    let mintPriceCurrency: 'eth' | 'usdc' | undefined
    try {
      const sale = await resolveOnchainSale(
        serverBaseClient(),
        collectionAddress as Address,
        BigInt(canonicalTokenId),
      )
      if (sale && sale.pricePerToken > 0n) {
        const nowSec = BigInt(Math.floor(Date.now() / 1000))
        const scheduled = sale.saleStart > nowSec
        // saleEnd 0 = no end; the max-uint64 sentinel is > nowSec, so a raw
        // compare reads it as live — same semantics as parseRealSaleEnd.
        const ended = sale.saleEnd !== 0n && sale.saleEnd < nowSec
        if (!scheduled && !ended) {
          mintPrice = sale.pricePerToken.toString()
          mintPriceCurrency = sale.currency
        }
      }
    } catch {}

    const listing = await createListing({
      collectionAddress,
      tokenId: canonicalTokenId,
      seller,
      price,
      sellerProceeds,
      royaltyReceiver,
      royaltyAmount,
      platformFee: platformFeeBig.toString(),
      platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
      currency,
      orderComponents,
      signature: onchainSignature,
      expiresAt,
      name: body.name,
      image: body.image,
      // Display attribution only — drop anything that isn't a well-formed
      // address so a malformed value can't sit in the row. Trust (the
      // artist-listing filter) never reads this field; it verifies the
      // seller against the KV moment-meta creator instead.
      creatorAddress:
        body.creatorAddress && isAddress(body.creatorAddress)
          ? body.creatorAddress.toLowerCase()
          : undefined,
      contentUri: body.contentUri,
      contentMime: body.contentMime,
      ...(mintPrice && mintPriceCurrency ? { mintPrice, mintPriceCurrency } : {}),
    })

    // For Pass-collection listings, mark this (tokenId, seller) as actively
    // listed on Kismet so processTransfer can distinguish a legitimate Kismet
    // secondary sale from a truly off-platform transfer when the webhook races
    // ahead of the fill PATCH's after() callbacks. TTL = remaining listing
    // lifetime so the flag auto-expires if the fill/cancel clear is missed.
    const gateConfig = await getGateConfig()
    if (
      gateConfig.passCollection
      && listing.collectionAddress.toLowerCase() === gateConfig.passCollection
    ) {
      const ttlSeconds = Math.max(0, Math.floor((listing.expiresAt - Date.now()) / 1000))
      if (ttlSeconds > 0) {
        await markKismetListed(
          gateConfig.passCollection,
          listing.tokenId,
          listing.seller,
          ttlSeconds,
        ).catch(() => {})
      }
    }

    return NextResponse.json({ listing }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create listing'
    const status = message.includes('already exists') ? 409 : 500
    return errorResponse(status, message)
  }
}
