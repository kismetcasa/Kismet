import { redis } from './redis'

// Per-owner "pinned showcase" ZSETs — one per profile section a user can
// curate. Mirrors lib/collected.ts: members are "<collection>:<tokenId>"
// tuples, score is pin time so reads come back newest-pinned first. Kept
// as three category-scoped keys (rather than one tagged set) so each maps
// 1:1 to the section it renders and the per-category cap is a plain ZCARD.
//
// Keyed by the profile's CANONICAL address (the API resolves it before
// writing) so an FC user's pins live alongside the same identity their
// mints/collected already resolve to.
export type PinCategory = 'mints' | 'collected' | 'listings'

const CATEGORIES: readonly PinCategory[] = ['mints', 'collected', 'listings']

// One curated row of the profile's grid per section — a showcase is a tight
// highlight reel, not a second feed. Small by design (and in line with how
// other products cap pins: IG 3, GitHub 6); the cap also bounds the read.
export const MAX_PINS_PER_CATEGORY = 4

export function isPinCategory(value: unknown): value is PinCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

const key = (category: PinCategory, address: string) =>
  `kismetart:pins:${category}:${address.toLowerCase()}`

/** Delete every pinned-showcase category for an address (all three keys).
 *  Admin profile-erase only. */
export async function clearAllPins(address: string): Promise<void> {
  await Promise.all(CATEGORIES.map((c) => redis.del(key(c, address))))
}

const member = (collection: string, tokenId: string) =>
  `${collection.toLowerCase()}:${tokenId}`

/**
 * Pin a moment into a category. Returns false when the category is already
 * at MAX_PINS_PER_CATEGORY and this would be a NEW member — the caller
 * surfaces that as a 409. Re-pinning an existing member just refreshes its
 * score (idempotent), so it's allowed even at the cap.
 */
export async function addPin(
  category: PinCategory,
  address: string,
  collection: string,
  tokenId: string,
): Promise<boolean> {
  const k = key(category, address)
  const m = member(collection, tokenId)

  const count = await redis.zcard(k)
  if (count >= MAX_PINS_PER_CATEGORY) {
    const existing = await redis.zscore(k, m)
    if (existing === null || existing === undefined) return false
  }

  await redis.zadd(k, { score: Date.now(), member: m })
  return true
}

export async function removePin(
  category: PinCategory,
  address: string,
  collection: string,
  tokenId: string,
): Promise<void> {
  await redis.zrem(key(category, address), member(collection, tokenId))
}

/**
 * All three pin sets for a profile, each newest-pinned first. Empty arrays
 * on any error so the profile view degrades to the full (non-pinned) layout
 * rather than throwing.
 */
export async function getAllPins(
  address: string,
): Promise<Record<PinCategory, string[]>> {
  try {
    const [mints, collected, listings] = await Promise.all([
      redis.zrange(key('mints', address), 0, -1, { rev: true }) as Promise<string[]>,
      redis.zrange(key('collected', address), 0, -1, { rev: true }) as Promise<string[]>,
      redis.zrange(key('listings', address), 0, -1, { rev: true }) as Promise<string[]>,
    ])
    return { mints, collected, listings }
  } catch {
    return { mints: [], collected: [], listings: [] }
  }
}
