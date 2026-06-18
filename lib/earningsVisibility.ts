import { redis } from './redis'

// Per-artist "earnings public" opt-in — the single gate for every public
// earnings surface (profile card, share card, leaderboard). One SET of opted-in
// addresses; earnings stay private until the artist pins them.
const KEY_EARNINGS_PUBLIC = 'kismetart:stats-public'

export async function isEarningsPublic(address: string): Promise<boolean> {
  try {
    return (await redis.sismember(KEY_EARNINGS_PUBLIC, address.toLowerCase())) === 1
  } catch {
    return false
  }
}

export async function setEarningsPublic(address: string, isPublic: boolean): Promise<void> {
  const member = address.toLowerCase()
  if (isPublic) await redis.sadd(KEY_EARNINGS_PUBLIC, member)
  else await redis.srem(KEY_EARNINGS_PUBLIC, member)
}

/** The full opted-in set (lowercased), for the leaderboard's public-only filter. */
export async function getPublicEarners(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(KEY_EARNINGS_PUBLIC)) as string[]
    return new Set(members.map((a) => a.toLowerCase()))
  } catch {
    return new Set()
  }
}
