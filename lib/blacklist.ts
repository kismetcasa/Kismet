import { redis } from './redis'
import { ADMIN_ADDRESS } from './config'

const KEY = 'kismetart:blacklist'

/**
 * ACTION blacklist — addresses listed here are blocked from creator
 * actions: mint, write (writing moments), list (secondary sales), and
 * airdrop. Collecting is intentionally NOT blocked — banned users can
 * still buy other people's content.
 *
 * Two sibling lists live in their own files for separation of concerns:
 *   - lib/pass-blacklist.ts → denies Pass validity (even when held)
 *   - lib/hidden-users.ts   → hides authored content from public feeds
 *
 * Wiring (enforcement points):
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
  try {
    const v = await redis.sismember(KEY, lower)
    return !!v
  } catch {
    return false
  }
}

export async function addToBlacklist(address: string): Promise<void> {
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) {
    throw new Error('Cannot blacklist the admin address')
  }
  await redis.sadd(KEY, lower)
}

export async function removeFromBlacklist(address: string): Promise<void> {
  await redis.srem(KEY, address.toLowerCase())
}

export async function listBlacklist(): Promise<string[]> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return Array.isArray(addrs) ? addrs.sort() : []
  } catch {
    return []
  }
}
