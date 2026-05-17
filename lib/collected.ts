import { redis } from './redis'

// Per-collector "what I've collected" ZSET. Written by /api/collect
// (direct mints) and /api/airdrop/notify (recipients); read by the
// timeline route's Collected tab. Centralized so the key shape and
// member format have a single source of truth.
const keyCollected = (collector: string) =>
  `kismetart:collected:${collector.toLowerCase()}`

const member = (collection: string, tokenId: string) =>
  `${collection.toLowerCase()}:${tokenId}`

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
