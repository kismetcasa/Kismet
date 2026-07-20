import { redis } from './redis'
import { memoize } from './memoCache'
import { strictRead } from './redisRead'

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
  // Route the single-key check through the cached set: a hot SSR path
  // (every moment + collection page render) used to fire its own
  // SISMEMBER per call, swamping Redis with reads of a set that
  // already changes only on hide/unhide writes. Now: one SMEMBERS
  // per pod per memoize TTL, then O(1) cache hits. Throw propagates
  // (not "fail open to visible") so the error boundary catches it —
  // a Redis blip must NEVER briefly reveal hidden content.
  const hidden = await getHiddenCollectionsSet()
  return hidden.has(address.toLowerCase())
}

export async function hideCollection(address: string): Promise<void> {
  await redis.sadd(HIDDEN_KEY, address.toLowerCase())
  // Own-pod consistency: read paths that cascade hide should see the
  // change immediately on the next request. Cross-pod TTL bounds drift.
  getHiddenCollectionsSet.invalidate()
}

export async function unhideCollection(address: string): Promise<void> {
  await redis.srem(HIDDEN_KEY, address.toLowerCase())
  getHiddenCollectionsSet.invalidate()
}

/**
 * Bulk lookup for filtering a collections feed. Single Redis call; returns
 * a Set of lowercase addresses for O(1) membership checks. Memoized 15 min;
 * the set changes only on hide/unhide writes which invalidate own-pod.
 */
async function _getHiddenCollectionsSet(): Promise<Set<string>> {
  // strictRead re-throws on a Redis failure → the error propagates through
  // memoize (which never caches rejections) to the SSR error boundary, so a
  // blip can't resolve to an empty set and briefly reveal hidden content. It
  // also stamps markRedisSuccess() and emits the uniform [redis] failure line.
  const members = await strictRead('getHiddenCollectionsSet', async () => {
    return (await redis.smembers(HIDDEN_KEY)) as string[]
  })
  return new Set(members.map((m) => m.toLowerCase()))
}
// 15-min memo: hide/unhide invalidate immediately, so the longer TTL only
// trims redundant SMEMBERS of an unchanged set (single instance → free).
export const getHiddenCollectionsSet = memoize(_getHiddenCollectionsSet, 15 * 60_000)
