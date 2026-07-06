import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { hideCollection, unhideCollection } from '@/lib/hiddenCollections'
import { hideMoment, unhideMoment } from '@/lib/hiddenMoments'
import { getHiddenListingsSet, hideListing, unhideListing, listingHideKey } from '@/lib/hiddenListings'
import { getListings } from '@/lib/listings'
import { errorResponse } from '@/lib/apiResponse'

interface HideBody {
  type?: 'moment' | 'collection' | 'listing'
  address?: string
  tokenId?: string
  // Listing hides key on the (collection, tokenId, seller) slot — the same
  // identity lib/listings enforces one active listing per — so the hide
  // survives a cancel/re-list cycle.
  seller?: string
  hidden?: boolean
}

/**
 * Admin-gated visibility toggle for any moment, collection, or marketplace
 * listing. The user-facing /api/moment/hide and /api/collection/hide gate on
 * creator / on-chain admin respectively; this route bypasses both for
 * platform moderation (there is no user-facing listing hide at all — sellers
 * cancel instead). Writes to the same Redis sets (hiddenMoments /
 * hiddenCollections / hiddenListings), so feed filtering picks up the change
 * immediately with no extra wiring. Auth via HttpOnly session cookie set by
 * /api/auth/login.
 */
export async function POST(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as HideBody | null
  if (!body) return errorResponse(400, 'Invalid body')

  const { type, address, tokenId, seller, hidden } = body
  if (type !== 'moment' && type !== 'collection' && type !== 'listing') {
    return errorResponse(400, 'type must be "moment", "collection", or "listing"')
  }
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  if (typeof hidden !== 'boolean') {
    return errorResponse(400, 'hidden must be a boolean')
  }

  if (type === 'moment') {
    if (!isValidTokenId(tokenId)) {
      return errorResponse(400, 'Invalid tokenId')
    }
    if (hidden) await hideMoment(address, tokenId)
    else await unhideMoment(address, tokenId)
  } else if (type === 'listing') {
    if (!isValidTokenId(tokenId)) {
      return errorResponse(400, 'Invalid tokenId')
    }
    if (!seller || !isAddress(seller)) {
      return errorResponse(400, 'Invalid seller')
    }
    if (hidden) await hideListing(address, tokenId, seller)
    else await unhideListing(address, tokenId, seller)
  } else {
    if (hidden) await hideCollection(address)
    else await unhideCollection(address)
  }

  return NextResponse.json({ ok: true, hidden })
}

/**
 * GET — admin-only enumeration of the active listings for one token, each
 * with its current hidden flag. Backs the dashboard's Hide-content card:
 * listings aren't URL-addressable (a token can carry one listing per
 * seller), so the card pastes a moment link and this endpoint surfaces the
 * hideable listings behind it — INCLUDING already-hidden ones, which the
 * public /api/listings feed filters out and the admin needs to see to
 * unhide. Admin-gated rather than public so hidden listings' existence
 * isn't enumerable by anyone else.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const { searchParams } = new URL(req.url)
  const address = searchParams.get('address')
  const tokenId = searchParams.get('tokenId')
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  if (!isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }

  // getListings scans the newest 500 listing ids (its internal cap) and
  // returns active ones; limit=500 keeps the whole scan rather than one
  // page. Fine for an admin tool — the market feed itself lives within
  // the same bound.
  const [{ listings }, hiddenListings] = await Promise.all([
    getListings({ page: 1, limit: 500, collection: address }),
    getHiddenListingsSet(),
  ])

  const rows = listings
    .filter((l) => l.tokenId === tokenId)
    .map((l) => ({
      id: l.id,
      seller: l.seller,
      price: l.price,
      currency: l.currency ?? 'eth',
      name: l.name,
      expiresAt: l.expiresAt,
      hidden: hiddenListings.has(listingHideKey(l.collectionAddress, l.tokenId, l.seller)),
    }))

  return NextResponse.json(
    { listings: rows },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
