import { shortAddress } from './inprocess'

interface ProfileEntry {
  name: string
  avatarUrl: string | undefined
  ts: number
  resolved: boolean
}

const cache = new Map<string, ProfileEntry>()
const TTL_RESOLVED = 5 * 60 * 1000
const TTL_FALLBACK = 30 * 1000

export async function fetchCreatorProfile(
  address: string,
): Promise<{ name: string; avatarUrl: string | undefined }> {
  const cached = cache.get(address)
  if (cached) {
    const ttl = cached.resolved ? TTL_RESOLVED : TTL_FALLBACK
    if (Date.now() - cached.ts < ttl) return { name: cached.name, avatarUrl: cached.avatarUrl }
  }
  try {
    const res = await fetch(`/api/profile/${address}`)
    const d = await res.json()
    const name: string = d.profile?.username || d.profile?.ensName || ''
    const avatarUrl: string | undefined = d.profile?.avatarUrl
    const resolved = !!name
    const entry = { name: name || shortAddress(address), avatarUrl, ts: Date.now(), resolved }
    cache.set(address, entry)
    return { name: entry.name, avatarUrl }
  } catch {
    return { name: shortAddress(address), avatarUrl: undefined }
  }
}
