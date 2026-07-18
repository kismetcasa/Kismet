import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { getHiddenCollectionsSet, hideCollection, unhideCollection } from '@/lib/hiddenCollections'
import { getHiddenMomentsSet, hideMoment, unhideMoment } from '@/lib/hiddenMoments'
import { fetchHiddenListingsSet, hideListing, unhideListing, listingHideKey } from '@/lib/hiddenListings'
import { getListings } from '@/lib/listings'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

// Same per-IP guard the sibling admin routes carry (hidden-users,
// hidden-profiles, blacklist). Auth is still the session cookie; this only
// bounds the request rate — the GET below does a 500-id market scan per
// call, so it shouldn't be free to hammer even with a valid cookie.
async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-hide:${ip}`, 30, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

interface HideBody {
  type?: 'moment' | 'collection' | 'listing'
  address?: string
  tokenId?: string
  // Listing hides key on the (collection, tokenId, seller) slot — the same
  // identity lib/listings enforces one active listing per. The slot's
  // terminal transitions (cancel/fill/expire) GC the hide (lib/listings), so
  // a per-listing hide is scoped to that listing's life; durable content
  // moderation that must persist across a re-list is moment/collection hide.
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
  const limited = await rateLimit(req)
  if (limited) return limited

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

  await recordAdminAction('content.hide', {
    actor: auth.signer,
    target: address.toLowerCase(),
    meta: { type, tokenId, seller, hidden },
  })
  return NextResponse.json({ ok: true, hidden })
}

/**
 * GET — admin-only enumeration of the active listings for one token, each
 * with its current per-listing hidden flag, plus the token's cascade state
 * (momentHidden / collectionHidden) so the dashboard can show WHY a
 * "visible"-flagged listing is still off the market. Backs the dashboard's
 * Hide-content card: listings aren't URL-addressable (a token can carry one
 * listing per seller), so the card pastes a moment link and this endpoint
 * surfaces the hideable listings behind it — INCLUDING already-hidden ones,
 * which the public /api/listings feed filters out and the admin needs to
 * see to unhide. Admin-gated rather than public so hidden listings'
 * existence isn't enumerable by anyone else.
 *
 * Known bound: enumeration shares getListings' newest-500 platform-wide
 * scan window (the same bound the market feed lives within), while the
 * seller profile tab reads an uncapped per-seller set — so a listing older
 * than the window can be publicly visible on a profile yet not appear
 * here. The moment/collection hide (which needs no enumeration and
 * cascades over the uncapped path too) is the lever for those; add a
 * per-token index if active-listing volume ever approaches the cap.
 */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

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

  // Fresh (unmemoized) hidden-listings read so a toggle is reflected on the
  // very next dashboard read even across instances/layers — parity with the
  // hidden-profiles admin GET. Moment/collection sets stay memoized: their
  // writes happen through this same route layer, so own-instance invalidate
  // already keeps them fresh here.
  const [{ listings }, hiddenListings, hiddenMoments, hiddenCollections] = await Promise.all([
    getListings({ page: 1, limit: 500, collection: address }),
    fetchHiddenListingsSet(),
    getHiddenMomentsSet(),
    getHiddenCollectionsSet(),
  ])

  // BigInt compare so a legacy/adversarial row stored with a non-canonical
  // tokenId ('01') still surfaces under the canonical query ('1') and stays
  // hideable — same normalization listingHideKey applies.
  const wanted = BigInt(tokenId)
  const rows = listings
    .filter((l) => {
      try {
        return BigInt(l.tokenId) === wanted
      } catch {
        return l.tokenId === tokenId
      }
    })
    .map((l) => ({
      id: l.id,
      seller: l.seller,
      price: l.price,
      currency: l.currency ?? 'eth',
      hidden: hiddenListings.has(listingHideKey(l.collectionAddress, l.tokenId, l.seller)),
    }))

  const lowerAddress = address.toLowerCase()
  return NextResponse.json(
    {
      momentHidden: hiddenMoments.has(`${lowerAddress}:${BigInt(tokenId).toString()}`),
      collectionHidden: hiddenCollections.has(lowerAddress),
      listings: rows,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
