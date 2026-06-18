import { redis } from './redis'
import { memoize } from './memoCache'
import { ADMIN_ADDRESS } from './config'

const KEY = 'kismetart:blacklist'

// Full-set cache — same pattern as lib/hidden-users.ts. Converts one
// SISMEMBER per action into one SMEMBERS per 5-minute window per process.
// Fails open (empty Set) so a Redis outage doesn't block every user.
// Own-pod consistency: invalidated on every add/remove.
async function _getBlacklistSet(): Promise<Set<string>> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return new Set(addrs.map((a) => a.toLowerCase()))
  } catch {
    return new Set()
  }
}
const getBlacklistSet = memoize(_getBlacklistSet, 5 * 60_000)

/**
 * ACTION blacklist — addresses listed here are blocked from creator
 * actions: mint, write (writing moments), list (secondary sales), and
 * airdrop.
 *
 * POLICY: this is intentionally narrow. The following are NOT blocked:
 *   - Collecting (a banned user can still buy others' content)
 *   - Following / being followed
 *   - Sending or receiving notifications
 * The rationale is asymmetric harm: creator actions produce content
 * and offers that the platform displays / surfaces, so they need a
 * moderation lever. Consumption and social actions only affect the
 * banned user's own experience or are mutually-consensual, so they
 * don't justify a hard block. If product later wants "full isolation,"
 * the additional enforcement points would be:
 *   - app/api/collect/route.ts POST          (recordCollected gate)
 *   - app/api/follow/[address]/route.ts POST (follow gate)
 *   - lib/notifications.ts → writeNotification (recipient + actor gate)
 *
 * Two sibling lists live in their own files for separation of concerns:
 *   - lib/pass-blacklist.ts → denies Pass validity (even when held)
 *   - lib/hidden-users.ts   → hides authored content from public feeds
 *
 * Wiring (current enforcement points):
 *   - lib/mint-proxy.ts                  → /api/mint, /api/write
 *   - app/api/listings/route.ts POST     → secondary listing creation
 *   - app/api/airdrop/notify/route.ts    → airdrop platform-recording
 *
 * Admin is hardcoded-exempt at both read and write so an accidental
 * self-blacklist can't lock the admin out of their own dashboard. Fails
 * open on Redis error so a transient outage can't accidentally block
 * every user — security at the chokepoints is layered (gate, on-chain
 * ownership, signature verification), this list is moderation policy.
 *
 * Coexists with main's hide system (lib/hiddenCollections,
 * lib/hiddenMoments): hide is creator-controlled per-content, blacklist
 * is admin-controlled per-address. Both compose where applicable.
 */
export async function isBlacklisted(address: string | null | undefined): Promise<boolean> {
  if (!address) return false
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) return false
  const set = await getBlacklistSet()
  return set.has(lower)
}

export async function addToBlacklist(address: string): Promise<void> {
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) {
    throw new Error('Cannot blacklist the admin address')
  }
  await redis.sadd(KEY, lower)
  getBlacklistSet.invalidate()
}

export async function removeFromBlacklist(address: string): Promise<void> {
  await redis.srem(KEY, address.toLowerCase())
  getBlacklistSet.invalidate()
}

export async function listBlacklist(): Promise<string[]> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return Array.isArray(addrs) ? addrs.sort() : []
  } catch {
    return []
  }
}
