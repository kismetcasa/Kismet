import { redis } from './redis'

// Set of "<lowercaseAddr>:<tokenId>" members. Created moments default to
// visible; entries are added when the creator hides one and removed on
// unhide. We keep all hidden moments in a single Set rather than per-user
// because the canonical lookup is "is this moment hidden?", which is O(1)
// against a single Set.
const HIDDEN_KEY = 'kismetart:hidden-moments'

const member = (collectionAddress: string, tokenId: string) =>
  `${collectionAddress.toLowerCase()}:${tokenId}`

export async function isMomentHidden(
  collectionAddress: string,
  tokenId: string,
): Promise<boolean> {
  // Upstash returns number (0 | 1); Boolean() handles either shape defensively.
  const result = await redis.sismember(HIDDEN_KEY, member(collectionAddress, tokenId))
  return Boolean(result)
}

export async function hideMoment(
  collectionAddress: string,
  tokenId: string,
): Promise<void> {
  await redis.sadd(HIDDEN_KEY, member(collectionAddress, tokenId))
}

export async function unhideMoment(
  collectionAddress: string,
  tokenId: string,
): Promise<void> {
  await redis.srem(HIDDEN_KEY, member(collectionAddress, tokenId))
}

/**
 * Bulk lookup for filtering a feed of moments. Single Redis call; returns
 * a Set keyed on `<lowercaseAddr>:<tokenId>` for O(1) membership checks.
 */
export async function getHiddenMomentsSet(): Promise<Set<string>> {
  const members = (await redis.smembers(HIDDEN_KEY)) as string[]
  return new Set(members.map((m) => m.toLowerCase()))
}
