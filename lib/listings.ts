import { redis } from './redis'
import { randomUUID } from 'crypto'
import type { SerializedOrderComponents } from './seaport'

export interface Listing {
  id: string
  collectionAddress: string
  tokenId: string
  seller: string
  price: string           // total buyer pays, in wei as string
  sellerProceeds: string  // seller receives after royalty, in wei as string
  royaltyReceiver: string
  royaltyAmount: string   // in wei as string
  orderComponents: SerializedOrderComponents
  signature: string
  createdAt: number       // ms
  expiresAt: number       // ms
  status: 'active' | 'filled' | 'cancelled'
  // Display metadata (denormalized for fast rendering)
  name?: string
  image?: string
  creatorAddress?: string
}

const KEY_ALL = 'kismetart:listings'
const keyById = (id: string) => `kismetart:listing:${id}`
// One active listing per (collection, tokenId, seller) — supports multiple sellers per token
const keyByOwned = (collection: string, tokenId: string, seller: string) =>
  `kismetart:listings:owned:${collection.toLowerCase()}:${tokenId}:${seller.toLowerCase()}`
const keyBySeller = (seller: string) =>
  `kismetart:listings:seller:${seller.toLowerCase()}`

export async function createListing(
  data: Omit<Listing, 'id' | 'createdAt' | 'status'>
): Promise<Listing> {
  // One active listing per seller per token
  const ownedId = await redis.get<string>(
    keyByOwned(data.collectionAddress, data.tokenId, data.seller)
  )
  if (ownedId) {
    const existing = await getListing(ownedId)
    if (existing && existing.status === 'active') {
      throw new Error('Active listing already exists for this token')
    }
  }

  const listing: Listing = {
    ...data,
    id: randomUUID(),
    createdAt: Date.now(),
    status: 'active',
  }

  await Promise.all([
    redis.zadd(KEY_ALL, { score: listing.createdAt, member: listing.id }),
    redis.set(keyById(listing.id), JSON.stringify(listing)),
    redis.set(keyByOwned(listing.collectionAddress, listing.tokenId, listing.seller), listing.id),
    redis.sadd(keyBySeller(listing.seller), listing.id),
  ])

  return listing
}

export async function getListing(id: string): Promise<Listing | null> {
  const raw = await redis.get<string | Listing>(keyById(id))
  if (!raw) return null
  return typeof raw === 'string' ? JSON.parse(raw) : raw
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

  const all = await Promise.all(ids.map((id) => getListing(id)))
  const now = Date.now()
  const stale: string[] = []

  const active = all.filter((l): l is Listing => {
    if (!l) return false
    if (l.status !== 'active' || l.expiresAt <= now) {
      stale.push(l.id)
      return false
    }
    return !collection || l.collectionAddress.toLowerCase() === collection.toLowerCase()
  })

  if (stale.length > 0) {
    redis.zrem(KEY_ALL, ...stale).catch(() => {})
  }

  const total = active.length
  const start = (page - 1) * limit
  return { listings: active.slice(start, start + limit), total }
}

export async function getListingsBySeller(seller: string): Promise<Listing[]> {
  const ids = await redis.smembers(keyBySeller(seller.toLowerCase())) as string[]
  if (!ids.length) return []
  const all = await Promise.all(ids.map((id) => getListing(id)))
  const now = Date.now()
  return all.filter(
    (l): l is Listing => l !== null && l.status === 'active' && l.expiresAt > now
  )
}

export async function updateListingStatus(
  id: string,
  status: 'filled' | 'cancelled'
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
