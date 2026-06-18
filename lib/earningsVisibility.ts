import { redis } from './redis'
import { memoize } from './memoCache'

// Per-artist "earnings public" opt-in — the gate for the public earnings
// surfaces (profile card, share card). One SET of opted-in
// addresses; earnings stay private until the artist pins them. The set is
// memoized (mirrors hidden-users) so the per-request check costs ~0 Redis: one
// SMEMBERS per TTL per pod, not per profile view. A toggle invalidates the
// own-pod cache immediately; other pods reflect it within the TTL.
const KEY_EARNINGS_PUBLIC = 'kismetart:stats-public'

async function _getPublicEarners(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(KEY_EARNINGS_PUBLIC)) as string[]
    return new Set(members.map((a) => a.toLowerCase()))
  } catch {
    return new Set()
  }
}
const getPublicEarners = memoize(_getPublicEarners, 60_000)

export async function isEarningsPublic(address: string): Promise<boolean> {
  return (await getPublicEarners()).has(address.toLowerCase())
}

export async function setEarningsPublic(address: string, isPublic: boolean): Promise<void> {
  const member = address.toLowerCase()
  if (isPublic) await redis.sadd(KEY_EARNINGS_PUBLIC, member)
  else await redis.srem(KEY_EARNINGS_PUBLIC, member)
  getPublicEarners.invalidate()
}
