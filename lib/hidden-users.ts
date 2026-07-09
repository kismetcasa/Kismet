import { redis } from './redis'
import { memoize } from './memoCache'
import { ADMIN_ADDRESS } from './config'

/**
 * Per-address content visibility filter. Hides every public-feed entry
 * authored by a listed address — moments (filtered by creator),
 * collections (filtered by artist), listings (filtered by seller),
 * featured rows, search results. The user's own profile still surfaces
 * their content TO THEMSELVES (and to admin) so they can manage it;
 * the filter only excludes from third-party-visible feeds.
 *
 * Distinct from main's hiddenCollections / hiddenMoments:
 *   - Those are per-content (one address can have some content visible
 *     and some hidden, set by the creator themselves or by admin).
 *   - This is per-author (everything the address produces is hidden, set
 *     only by admin).
 *
 * Distinct from lib/blacklist:
 *   - The action blacklist blocks the address from PERFORMING actions
 *     (mint, list, airdrop). It doesn't hide their existing content.
 *   - This list HIDES their existing content but doesn't block new
 *     actions. Blacklist + hide together = full ban.
 *
 * Distinct from lib/hidden-profiles:
 *   - This list hides the CONTENT an address authored; their profile
 *     page stays reachable.
 *   - hidden-profiles hides the PROFILE (identity surfaces: page, API,
 *     search, share card) but leaves their content's visibility alone.
 *   - Combine both to make a user fully invisible.
 *
 * Admin is exempt at both read and write so an accidental self-listing
 * can't hide admin's content from the admin's own views.
 *
 * Memoization mirrors lib/hiddenCollections — 15-min TTL with own-pod
 * invalidate() on every write so the next read after a hide/unhide
 * reflects the change immediately on the same pod.
 */

const KEY = 'kismetart:hidden-users'

export async function addHiddenUser(address: string): Promise<void> {
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) {
    throw new Error('Cannot hide the admin address')
  }
  await redis.sadd(KEY, lower)
  getHiddenUsersSet.invalidate()
}

export async function removeHiddenUser(address: string): Promise<void> {
  await redis.srem(KEY, address.toLowerCase())
  getHiddenUsersSet.invalidate()
}

export async function listHiddenUsers(): Promise<string[]> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return Array.isArray(addrs) ? addrs.sort() : []
  } catch {
    return []
  }
}

/**
 * Bulk lookup for filtering a feed. Single Redis call; returns a Set
 * of lowercase addresses for O(1) membership checks. Same pattern as
 * getHiddenCollectionsSet — 15-min memoized, own-pod invalidates on every
 * hide/unhide.
 */
async function _getHiddenUsersSet(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(KEY)) as string[]
    return new Set(members.map((m) => m.toLowerCase()))
  } catch {
    // Fail open: a transient Redis outage shouldn't blank every feed.
    // Worst case is hidden content briefly visible for the memo TTL.
    return new Set()
  }
}
// 15-min memo: admin hide/unhide invalidate immediately, so the longer TTL
// only trims redundant SMEMBERS of an unchanged set (single instance → free).
export const getHiddenUsersSet = memoize(_getHiddenUsersSet, 15 * 60_000)
