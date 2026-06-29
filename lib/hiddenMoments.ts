import { redis } from './redis'
import { memoize } from './memoCache'

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
  // Route through the cached set — see isCollectionHidden for rationale.
  // Throw propagates so a Redis blip never reveals hidden content; the
  // error boundary catches it at the SSR layer.
  const hidden = await getHiddenMomentsSet()
  return hidden.has(member(collectionAddress, tokenId))
}

export async function hideMoment(
  collectionAddress: string,
  tokenId: string,
): Promise<void> {
  await redis.sadd(HIDDEN_KEY, member(collectionAddress, tokenId))
  // Own-pod consistency: the creator's next feed read should already see
  // the moment filtered out. Cross-pod pods catch up on TTL expiry.
  getHiddenMomentsSet.invalidate()
}

export async function unhideMoment(
  collectionAddress: string,
  tokenId: string,
): Promise<void> {
  await redis.srem(HIDDEN_KEY, member(collectionAddress, tokenId))
  getHiddenMomentsSet.invalidate()
}

/**
 * Bulk lookup for filtering a feed of moments. Single Redis call; returns
 * a Set keyed on `<lowercaseAddr>:<tokenId>` for O(1) membership checks.
 * Memoized 5 min; the underlying set changes only on hide/unhide writes,
 * which invalidate own-pod immediately.
 */
async function _getHiddenMomentsSet(): Promise<Set<string>> {
  const members = (await redis.smembers(HIDDEN_KEY)) as string[]
  return new Set(members.map((m) => m.toLowerCase()))
}
// 15-min memo: every hide/unhide calls .invalidate() so own-pod reads are
// already fresh; the TTL only bounds redundant SMEMBERS of an unchanged set
// (single instance → no cross-pod staleness, so this is a free command saving).
export const getHiddenMomentsSet = memoize(_getHiddenMomentsSet, 15 * 60_000)
