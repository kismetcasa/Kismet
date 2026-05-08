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
  // Lowercase the cache key so callers passing mixed-case addresses
  // (e.g. from on-chain reads) don't fan out into duplicate cache
  // entries that miss each other and cause repeated /api/profile calls.
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached) {
    const ttl = cached.resolved ? TTL_RESOLVED : TTL_FALLBACK
    if (Date.now() - cached.ts < ttl) return { name: cached.name, avatarUrl: cached.avatarUrl }
  }
  try {
    const res = await fetch(`/api/profile/${key}`)
    const d = await res.json()
    const name: string = d.profile?.username || d.profile?.ensName || ''
    const avatarUrl: string | undefined = d.profile?.avatarUrl
    const resolved = !!name
    const entry = { name: name || shortAddress(address), avatarUrl, ts: Date.now(), resolved }
    cache.set(key, entry)
    return { name: entry.name, avatarUrl }
  } catch {
    return { name: shortAddress(address), avatarUrl: undefined }
  }
}
