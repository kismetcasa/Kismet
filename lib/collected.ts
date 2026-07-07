import { redis } from './redis'

// Per-collector "what I've collected" ZSET. Written by /api/collect
// (direct mints) and /api/airdrop/notify (recipients); read by the
// timeline route's Collected tab. Centralized so the key shape and
// member format have a single source of truth.
const keyCollected = (collector: string) =>
  `kismetart:collected:${collector.toLowerCase()}`

const member = (collection: string, tokenId: string) =>
  `${collection.toLowerCase()}:${tokenId}`

/** Delete a collector's entire collected ZSET. Admin profile-erase only.
 *  Re-derives only from NEW collects going forward (it's event-sourced,
 *  not chain-backfilled) — acceptable for erase targets, who have none. */
export async function deleteCollected(collector: string): Promise<void> {
  await redis.del(keyCollected(collector))
}

export async function recordCollected(
  collector: string,
  collection: string,
  tokenId: string,
  timestamp: number = Date.now(),
): Promise<void> {
  await redis.zadd(keyCollected(collector), {
    score: timestamp,
    member: member(collection, tokenId),
  })
}

// Returns "<collection>:<tokenId>" tuples newest-first. Empty array on
// any error so callers can use it as a fallback list without try/catch.
export async function getCollectedMembers(collector: string): Promise<string[]> {
  try {
    return (await redis.zrange(keyCollected(collector), 0, -1, {
      rev: true,
    })) as string[]
  } catch {
    return []
  }
}

// Single-membership check (ZSCORE) — cheaper than fetching the whole set when
// you only need to know whether one ref was collected (e.g. validating a
// theme-source moment belongs to the owner). false on any error.
export async function isCollected(
  collector: string,
  collection: string,
  tokenId: string,
): Promise<boolean> {
  try {
    const score = await redis.zscore(keyCollected(collector), member(collection, tokenId))
    return score !== null && score !== undefined
  } catch {
    return false
  }
}
