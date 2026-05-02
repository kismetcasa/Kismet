import { redis } from './redis'
import { randomUUID } from 'crypto'

export interface Profile {
  address: string
  username?: string
  avatarUrl?: string
  updatedAt: number
}

const keyByAddress = (address: string) =>
  `kismetart:profile:${address.toLowerCase()}`
const keyNonce = (address: string) =>
  `kismetart:nonce:${address.toLowerCase()}`
const KEY_PROFILES = 'kismetart:profiles'

export async function getProfile(address: string): Promise<Profile> {
  const raw = await redis.get<string | Profile>(keyByAddress(address))
  const base: Profile = { address: address.toLowerCase(), updatedAt: 0 }
  if (!raw) return base
  const parsed: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
  return { ...base, ...parsed }
}

export async function upsertProfile(
  address: string,
  data: Partial<Pick<Profile, 'username' | 'avatarUrl'>>
): Promise<Profile> {
  const existing = await getProfile(address)
  const updated: Profile = { ...existing, ...data, address: address.toLowerCase(), updatedAt: Date.now() }
  await Promise.all([
    redis.set(keyByAddress(address), JSON.stringify(updated)),
    redis.sadd(KEY_PROFILES, address.toLowerCase()),
  ])
  return updated
}

export async function trackWallet(address: string): Promise<void> {
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return
  await redis.sadd(KEY_PROFILES, address.toLowerCase()).catch(() => {})
}

export async function searchProfiles(query: string): Promise<Profile[]> {
  const q = query.trim().toLowerCase()
  const isAddressQuery = /^0x[0-9a-fA-F]+$/.test(q)

  const addresses = (await redis.smembers(KEY_PROFILES)) as string[]
  const results: Profile[] = []

  if (isAddressQuery) {
    // Filter indexed wallets by address prefix
    const matching = addresses.filter(a => a.startsWith(q))
    if (matching.length > 0) {
      const raws = await redis.mget<(string | Profile | null)[]>(...matching.map(keyByAddress))
      for (const raw of raws) {
        if (!raw) continue
        const p: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
        results.push(p)
        if (results.length >= 20) break
      }
    }
    // If querying a full address and not already found, do a direct lookup
    // so any wallet is discoverable even if they haven't interacted yet
    if (q.length === 42 && !results.some(r => r.address === q)) {
      results.unshift(await getProfile(q))
    }
  } else {
    // Username search across all indexed profiles
    if (!addresses.length) return []
    const raws = await redis.mget<(string | Profile | null)[]>(...addresses.map(keyByAddress))
    for (const raw of raws) {
      if (!raw) continue
      const p: Profile = typeof raw === 'string' ? JSON.parse(raw) : raw
      if ((p.username ?? '').toLowerCase().includes(q)) {
        results.push(p)
        if (results.length >= 20) break
      }
    }
  }

  return results
}

// Nonce for wallet signature verification — expires in 5 minutes
export async function createNonce(address: string): Promise<string> {
  const nonce = randomUUID()
  await redis.setex(keyNonce(address), 300, nonce)
  return nonce
}

export async function consumeNonce(address: string, nonce: string): Promise<boolean> {
  const stored = await redis.get<string>(keyNonce(address))
  if (!stored || stored !== nonce) return false
  await redis.del(keyNonce(address))
  return true
}
