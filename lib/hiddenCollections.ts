import { redis } from './redis'

// Set of lowercase collection addresses the creator has hidden from public
// feeds. Mirrors hiddenMoments at the collection level — a creator can hide
// a whole collection and every moment inside it inherits the filter without
// having to hide each moment individually.
//
// The cascade is read-time across every surface that filters hidden moments:
// /api/collections, /api/collections/[scope]/eligibility, /api/timeline,
// /api/moment, /api/featured/collections-hydrated, and search (moments +
// collections). New mints into a hidden collection are automatically hidden
// because the filter resolves at read time; unhiding the collection
// restores everything except moments that were independently hide-marked
// (those keep their per-moment hide, which is treated as a stronger signal).
const HIDDEN_KEY = 'kismetart:hidden-collections'

export async function isCollectionHidden(address: string): Promise<boolean> {
  // Upstash returns number (0 | 1); Boolean() handles either shape defensively.
  const result = await redis.sismember(HIDDEN_KEY, address.toLowerCase())
  return Boolean(result)
}

export async function hideCollection(address: string): Promise<void> {
  await redis.sadd(HIDDEN_KEY, address.toLowerCase())
}

export async function unhideCollection(address: string): Promise<void> {
  await redis.srem(HIDDEN_KEY, address.toLowerCase())
}

/**
 * Bulk lookup for filtering a collections feed. Single Redis call; returns
 * a Set of lowercase addresses for O(1) membership checks.
 */
export async function getHiddenCollectionsSet(): Promise<Set<string>> {
  const members = (await redis.smembers(HIDDEN_KEY)) as string[]
  return new Set(members.map((m) => m.toLowerCase()))
}
