import { redis } from './redis'
import { memoize } from './memoCache'
import { ADMIN_ADDRESS } from './config'

/**
 * Admin-hidden PROFILES — removes an address's identity surfaces:
 * the /profile/[address] page 404s for everyone but the owner (checked
 * against their FID-sibling wallets), /api/profile/[address] returns 404,
 * the /api/profiles batch resolver returns the empty identity (clients
 * fall back to shortAddress), profile search stops returning them, and
 * the profile OG share card renders without name/avatar/earnings.
 *
 * Profiles are deliberately NOT deletable: they're keyed by wallet
 * address, the owner can recreate one with the next signed PUT, and the
 * user's actual content lives on-chain — a delete would be destructive
 * yet trivially reversible by its subject. Hiding is the enforceable
 * admin lever, and it's reversible by admin alone.
 *
 * Distinct from lib/hidden-users:
 *   - hidden-users hides the CONTENT an address authored (moments,
 *     collections, listings) from public feeds, but the profile page
 *     itself stays reachable.
 *   - hidden-profiles hides the PROFILE (identity), but their content
 *     keeps whatever visibility it already had.
 * The lists compose like the rest of the moderation surface: combine
 * both to make a user fully invisible; add the action blacklist for a
 * full ban.
 *
 * Admin is exempt at write so an accidental self-listing can't take the
 * admin's own profile down.
 *
 * Reads fail OPEN (empty set) like hidden-users: a transient Redis
 * outage briefly re-revealing a hidden profile beats 404ing/500ing every
 * profile surface on the platform.
 *
 * Memoization mirrors lib/hidden-users — 15-min TTL with own-pod
 * invalidate() on every write.
 */

const KEY = 'kismetart:hidden-profiles'

export async function addHiddenProfile(address: string): Promise<void> {
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) {
    throw new Error('Cannot hide the admin profile')
  }
  await redis.sadd(KEY, lower)
  getHiddenProfilesSet.invalidate()
}

export async function removeHiddenProfile(address: string): Promise<void> {
  await redis.srem(KEY, address.toLowerCase())
  getHiddenProfilesSet.invalidate()
}

export async function listHiddenProfiles(): Promise<string[]> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return Array.isArray(addrs) ? addrs.sort() : []
  } catch {
    return []
  }
}

/**
 * Direct (uncached) read of the hidden-profiles set. Used by the
 * page-level gate (isProfileIdentityHidden): the profile page and the
 * admin routes compile into different Next.js module layers (RSC vs
 * route handlers), so the memoized getter below can't be own-pod
 * invalidated across that boundary — an admin's hide would leave the
 * profile page serving for the full memo TTL. Page gates therefore read
 * through (the set is tiny; one SMEMBERS per profile view, deduped
 * per-request by React cache at the call site), while bulk feed filters
 * (search, the batch identity resolver) ride the memo below.
 */
export async function fetchHiddenProfilesSet(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(KEY)) as string[]
    return new Set(members.map((m) => m.toLowerCase()))
  } catch {
    // Fail open: a transient Redis outage shouldn't 404 every profile.
    // Worst case is a hidden profile briefly visible for the memo TTL.
    return new Set()
  }
}

/**
 * Memoized lookup for bulk feed filters (search, batch resolver). Same
 * pattern as getHiddenUsersSet — 15-min TTL, own-pod invalidates on every
 * write. NOT for page-level gates; see fetchHiddenProfilesSet.
 */
export const getHiddenProfilesSet = memoize(fetchHiddenProfilesSet, 15 * 60_000)
