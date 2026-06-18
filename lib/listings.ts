import { after } from 'next/server'
import { redis } from './redis'
import { bestEffort } from './bestEffort'
import type { SerializedOrderComponents } from './seaport'
import { fanoutToFollowers, writeNotification } from './notifications'
import { PLATFORM_FEE_RECIPIENT } from './platformFee'
import { clearKismetListed } from './pass-validity'

export interface Listing {
  id: string
  collectionAddress: string
  tokenId: string
  seller: string
  // price/sellerProceeds/royaltyAmount are denominated in the currency's base
  // units: wei for ETH (18 dp), USDC base units (6 dp) for USDC. The currency
  // field disambiguates which.
  price: string
  sellerProceeds: string
  royaltyReceiver: string
  royaltyAmount: string
  // 'eth' for native; 'usdc' for ERC20 USDC consideration. Older rows minted
  // before USDC support are read with a default of 'eth' (see getListing).
  currency: 'eth' | 'usdc'
  // Platform fee baked into the Seaport consideration at index 1.
  // Older rows created before fee support default to '0' (see getListing).
  // INFORMATIONAL ONLY — all financial logic uses orderComponents.consideration
  // directly. On-chain, Seaport pays based on what the seller signed, not these
  // stored values. Do not use these fields for financial calculations.
  platformFee: string
  platformFeeRecipient: string
  orderComponents: SerializedOrderComponents
  signature: string
  createdAt: number       // ms
  expiresAt: number       // ms
  status: 'active' | 'filled' | 'cancelled' | 'expired'
  // Display metadata (denormalized for fast rendering)
  name?: string
  image?: string
  creatorAddress?: string
  // For writing-type moments: content uri (typically ar://) + mime ('text/plain').
  // MarketCard fetches the body via the shared text cache when these are
  // present and renders a preview snippet instead of "no preview".
  contentUri?: string
  contentMime?: string
}

const KEY_ALL = 'kismetart:listings'
const keyById = (id: string) => `kismetart:listing:${id}`
// One active listing per (collection, tokenId, seller) — supports multiple sellers per token
const keyByOwned = (collection: string, tokenId: string, seller: string) =>
  `kismetart:listings:owned:${collection.toLowerCase()}:${tokenId}:${seller.toLowerCase()}`
const keyBySeller = (seller: string) =>
  `kismetart:listings:seller:${seller.toLowerCase()}`
// Claim key prevents duplicate expiry notifications across concurrent requests
const keyExpiredNotif = (id: string) => `kismetart:listing-notified:${id}`

export async function createListing(
  data: Omit<Listing, 'id' | 'createdAt' | 'status'>
): Promise<Listing> {
  const listing: Listing = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    status: 'active',
  }

  const ownedKey = keyByOwned(data.collectionAddress, data.tokenId, data.seller)

  // Atomic SET NX — only succeeds if no listing already occupies this slot.
  // Two concurrent POSTs for the same token race here; exactly one wins.
  // Non-atomic read-then-write (the prior approach) had a TOCTOU window where
  // both requests saw no incumbent and both created orphaned listings.
  const claimed = await redis.set(ownedKey, listing.id, { nx: true })
  if (!claimed) {
    // NX failed — someone else holds the slot. Check whether their listing is
    // still active (it may have been cancelled/expired since we entered here).
    const incumbentId = await redis.get<string>(ownedKey)
    const incumbent = incumbentId ? await getListing(incumbentId) : null
    if (incumbent && incumbent.status === 'active') {
      throw new Error('Active listing already exists for this token')
    }
    // Incumbent gone (inactive/expired/orphaned) — take the slot.
    await redis.set(ownedKey, listing.id)
  }

  await Promise.all([
    redis.zadd(KEY_ALL, { score: listing.createdAt, member: listing.id }),
    redis.set(keyById(listing.id), JSON.stringify(listing)),
    // ownedKey is already written above via SET NX
    redis.sadd(keyBySeller(listing.seller), listing.id),
  ])

  after(() =>
    fanoutToFollowers(listing.seller, {
      type: 'listing_created',
      tokenAddress: listing.collectionAddress,
      tokenId: listing.tokenId,
      tokenName: listing.name,
      tokenImage: listing.image,
      price: listing.price,
      currency: listing.currency,
      listingId: listing.id,
    }),
  )

  return listing
}

export async function getListing(id: string): Promise<Listing | null> {
  const raw = await redis.get<string | Listing>(keyById(id))
  if (!raw) return null
  const listing: Listing = typeof raw === 'string' ? JSON.parse(raw) : raw
  // Legacy rows minted before USDC support don't carry a currency field —
  // default to ETH so MarketCard / BuyButton don't accidentally enter the
  // USDC code path.
  if (!listing.currency) listing.currency = 'eth'
  // Legacy rows created before platform-fee support have no fee fields.
  if (!listing.platformFee) {
    listing.platformFee = '0'
    listing.platformFeeRecipient = PLATFORM_FEE_RECIPIENT
  }
  return listing
}

// Bulk variant of `getListing`. One MGET in place of N parallel GETs.
// Preserves the legacy currency='eth' fallback so callers see identical
// shapes whether they go through the single or batch path.
async function getListingsBatch(ids: string[]): Promise<(Listing | null)[]> {
  if (ids.length === 0) return []
  const raws = await redis.mget<(string | Listing | null)[]>(...ids.map(keyById))
  return raws.map((raw) => {
    if (!raw) return null
    const listing: Listing = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!listing.currency) listing.currency = 'eth'
    if (!listing.platformFee) {
      listing.platformFee = '0'
      listing.platformFeeRecipient = PLATFORM_FEE_RECIPIENT
    }
    return listing
  })
}

// Look up a specific seller's active listing for a token
export async function getListingForToken(
  collectionAddress: string,
  tokenId: string,
  seller: string
): Promise<Listing | null> {
  const id = await redis.get<string>(
    keyByOwned(collectionAddress.toLowerCase(), tokenId, seller.toLowerCase())
  )
  if (!id) return null
  const listing = await getListing(id)
  if (!listing || listing.status !== 'active' || listing.expiresAt <= Date.now()) return null
  return listing
}

// Periodic sweep — called by lib/backgroundTasks so expiry is claimed
// once per cycle instead of per /api/listings request. The request-time
// check in getListings stays as a safety net for between-sweep gaps.
export async function sweepExpiredListings(): Promise<void> {
  const ids = (await redis.zrange(KEY_ALL, 0, MAX_LISTINGS_SCAN - 1, { rev: true })) as string[]
  if (ids.length === 0) return
  const now = Date.now()
  const expired = (await getListingsBatch(ids)).filter(
    (l): l is Listing => l !== null && l.status === 'active' && l.expiresAt <= now,
  )
  if (expired.length > 0) await handleExpiredListings(expired)
}

// Mark expired listings as expired in Redis and fire a notification for each.
// A claim key (NX) ensures exactly one notification per listing even under concurrency.
async function handleExpiredListings(listings: Listing[]): Promise<void> {
  await Promise.all(listings.map(async (listing) => {
    const claimed = await redis.set(keyExpiredNotif(listing.id), '1', {
      nx: true,
      ex: 7 * 24 * 60 * 60,
    })
    if (!claimed) return

    const updated: Listing = { ...listing, status: 'expired' }
    await Promise.all([
      redis.set(keyById(listing.id), JSON.stringify(updated)),
      redis.del(keyByOwned(listing.collectionAddress, listing.tokenId, listing.seller)),
      redis.zrem(KEY_ALL, listing.id),
      clearKismetListed(listing.collectionAddress, listing.tokenId, listing.seller).catch(() => {}),
    ])

    await writeNotification({
      type: 'listing_expired',
      recipient: listing.seller,
      tokenAddress: listing.collectionAddress,
      tokenId: listing.tokenId,
      tokenName: listing.name,
      tokenImage: listing.image,
      price: listing.price,
      // Pair the price with its currency so NotificationRow renders USDC
      // listings correctly (defaults to ETH otherwise).
      currency: listing.currency,
      listingId: listing.id,
    })
  }))
}

const MAX_LISTINGS_SCAN = 500

export async function getListings({
  page = 1,
  limit = 18,
  collection,
}: {
  page?: number
  limit?: number
  collection?: string
} = {}): Promise<{ listings: Listing[]; total: number }> {
  const ids = (await redis.zrange(KEY_ALL, 0, MAX_LISTINGS_SCAN - 1, { rev: true })) as string[]

  const all = await getListingsBatch(ids)
  const now = Date.now()
  const expired: Listing[] = []
  const ghosts: string[] = [] // ZSET entries with no/non-active data — clean up

  const active = all.filter((l, idx): l is Listing => {
    if (!l) {
      ghosts.push(ids[idx])
      return false
    }
    if (l.status === 'active' && l.expiresAt <= now) {
      expired.push(l)
      return false
    }
    if (l.status !== 'active') {
      ghosts.push(l.id)
      return false
    }
    return !collection || l.collectionAddress.toLowerCase() === collection.toLowerCase()
  })

  if (expired.length > 0) {
    after(() => handleExpiredListings(expired))
  }
  if (ghosts.length > 0) {
    redis.zrem(KEY_ALL, ...ghosts).catch(bestEffort('listings.sweepGhosts', { count: ghosts.length }))
  }

  const total = active.length
  const start = (page - 1) * limit
  return { listings: active.slice(start, start + limit), total }
}

export async function getListingsBySeller(seller: string): Promise<Listing[]> {
  const ids = await redis.smembers(keyBySeller(seller.toLowerCase())) as string[]
  if (!ids.length) return []
  const all = await getListingsBatch(ids)
  const now = Date.now()
  const expired: Listing[] = []

  const active = all.filter((l): l is Listing => {
    if (!l) return false
    if (l.status === 'active' && l.expiresAt <= now) {
      expired.push(l)
      return false
    }
    return l.status === 'active'
  })

  if (expired.length > 0) {
    after(() => handleExpiredListings(expired))
  }

  return active
}

export async function updateListingStatus(
  id: string,
  status: 'filled' | 'cancelled' | 'expired'
): Promise<void> {
  const listing = await getListing(id)
  if (!listing) return
  const updated: Listing = { ...listing, status }
  await Promise.all([
    redis.set(keyById(id), JSON.stringify(updated)),
    redis.del(keyByOwned(listing.collectionAddress, listing.tokenId, listing.seller)),
    redis.zrem(KEY_ALL, id),
  ])
}
