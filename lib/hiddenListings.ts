import { redis } from './redis'
import { memoize } from './memoCache'
import { getHiddenMomentsSet } from './hiddenMoments'
import { getHiddenCollectionsSet } from './hiddenCollections'
import { getHiddenUsersSet } from './hidden-users'
import type { Listing } from './listings'

// Set of "<lowercaseAddr>:<tokenId>:<lowercaseSeller>" members — the same
// (collection, tokenId, seller) triple lib/listings keys its owned-slot on,
// NOT the listing's UUID. Keying on the slot means a hide survives a
// cancel/re-list cycle: the re-listed order lands in the same slot and stays
// hidden, so admin moderation isn't whack-a-mole against fresh listing ids.
//
// Admin-only writes (via /api/admin/hide, type "listing") — there is no
// seller-facing hide because a seller who wants a listing gone can already
// cancel it. Mirrors hiddenMoments at the marketplace level.
const HIDDEN_KEY = 'kismetart:hidden-listings'

// Canonical decimal form for tokenIds at every hide-decision boundary.
// isValidTokenId accepts leading zeros ('01'), and the Seaport order checks
// compare via BigInt — so without this, a listing POSTed with tokenId '01'
// would key a different member than the admin's hide of token '1' and evade
// both the per-listing hide and the hidden-moment cascade. The listings POST
// canonicalizes at ingress too; this is the defense for legacy/adversarial
// stored rows. Falls back to the raw string for non-numeric input so a
// corrupt legacy row degrades to exact-match instead of throwing.
const canonicalTokenId = (tokenId: string): string => {
  try {
    return BigInt(tokenId).toString()
  } catch {
    return tokenId
  }
}

/** Canonical member key for the hidden-listings set. Exported so admin
 *  surfaces checking many rows against getHiddenListingsSet build the
 *  exact same key shape. */
export const listingHideKey = (
  collectionAddress: string,
  tokenId: string,
  seller: string,
) => `${collectionAddress.toLowerCase()}:${canonicalTokenId(tokenId)}:${seller.toLowerCase()}`

export async function hideListing(
  collectionAddress: string,
  tokenId: string,
  seller: string,
): Promise<void> {
  await redis.sadd(HIDDEN_KEY, listingHideKey(collectionAddress, tokenId, seller))
  // Own-pod consistency: the next market read should already see the
  // listing filtered out. Cross-pod pods catch up on TTL expiry.
  getHiddenListingsSet.invalidate()
}

export async function unhideListing(
  collectionAddress: string,
  tokenId: string,
  seller: string,
): Promise<void> {
  await redis.srem(HIDDEN_KEY, listingHideKey(collectionAddress, tokenId, seller))
  getHiddenListingsSet.invalidate()
}

/**
 * Direct (uncached) read of the hidden-listings set. The admin dashboard's
 * listing-status GET uses this so a toggle is reflected on the very next
 * read even across instances/layers (parity with listHiddenProfiles on the
 * hidden-profiles admin GET); feed filters ride the memo below.
 */
export async function fetchHiddenListingsSet(): Promise<Set<string>> {
  const members = (await redis.smembers(HIDDEN_KEY)) as string[]
  return new Set(members.map((m) => m.toLowerCase()))
}

// 15-min memo for feed filtering: every hide/unhide calls .invalidate() so
// own-pod reads are already fresh; the TTL only bounds redundant SMEMBERS of
// an unchanged set.
export const getHiddenListingsSet = memoize(fetchHiddenListingsSet, 15 * 60_000)

/** The subset of listing fields visibility is decided on. Derived from the
 *  stored Listing shape so the two can't drift (cycle-free: lib/listings
 *  does not import this module). */
export type ListingIdentity = Pick<
  Listing,
  'collectionAddress' | 'tokenId' | 'seller' | 'creatorAddress'
>

export interface ListingVisibility {
  /**
   * Content-level hides: the listing itself, its moment, or its whole
   * collection is hidden. These apply EVERYWHERE — feeds, deeplink
   * resolution, and agent buy preparation — because they mean "this item
   * should not be on the market", not merely "keep it out of feeds".
   * (The listings deeplink additionally exempts the authenticated seller
   * so they can still resolve their own hidden listing to cancel it.)
   */
  contentHidden(l: ListingIdentity): boolean
  /**
   * Full public-feed filter: content-level hides PLUS author-level hides
   * (seller or creator on the admin hidden-users list). Author-level hides
   * only strip feeds — direct deeplinks stay resolvable, matching the
   * hidden-users contract ("excludes from third-party-visible feeds").
   * creatorAddress is client-denormalized display data, so the creator
   * check is best-effort; the seller + content checks are authoritative.
   */
  feedHidden(l: ListingIdentity): boolean
}

/**
 * Read-time visibility for marketplace listings. This is where "hide
 * content" extends to the market: hiding a moment (or collection, or an
 * author) removes its listings from every listing surface with no extra
 * writes, exactly like the timeline's read-time cascade for moments.
 *
 * Fetches all four hide sets in parallel (each memoized 15 min, so this is
 * ~free after first call per pod). The three content sets fail CLOSED
 * (throw) — a Redis blip must never briefly reveal hidden content — while
 * the hidden-users set fails OPEN inside its own getter, per each lib's
 * existing policy. Callers with a pre-existing degrade-to-empty contract
 * (agent discover) catch the throw and return empty rows: equally
 * fail-closed for content, without turning a blip into a 5xx.
 */
export async function getListingVisibility(): Promise<ListingVisibility> {
  const [hiddenListings, hiddenMoments, hiddenCollections, hiddenUsers] =
    await Promise.all([
      getHiddenListingsSet(),
      getHiddenMomentsSet(),
      getHiddenCollectionsSet(),
      getHiddenUsersSet(),
    ])

  const contentHidden = (l: ListingIdentity): boolean => {
    const collection = l.collectionAddress.toLowerCase()
    return (
      hiddenListings.has(listingHideKey(l.collectionAddress, l.tokenId, l.seller)) ||
      // Same canonical form hiddenMoments members use in practice — see
      // canonicalTokenId above for why the stored tokenId can't be trusted raw.
      hiddenMoments.has(`${collection}:${canonicalTokenId(l.tokenId)}`) ||
      hiddenCollections.has(collection)
    )
  }

  const feedHidden = (l: ListingIdentity): boolean => {
    if (contentHidden(l)) return true
    if (hiddenUsers.has(l.seller.toLowerCase())) return true
    const creator = l.creatorAddress?.toLowerCase()
    return !!creator && hiddenUsers.has(creator)
  }

  return { contentHidden, feedHidden }
}
