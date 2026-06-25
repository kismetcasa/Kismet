import { shortAddress } from './inprocess'
import { LRUCache } from './lruCache'

// Shape of /api/profile/[address] responses (subset we actually read).
// `displayName` is server-computed: collapses username → farcaster.username
// → ensName so consumers don't have to repeat that precedence chain.
type ProfileResponse = {
  profile?: {
    username?: string
    avatarUrl?: string
    ensName?: string
    displayName?: string | null
  }
}

interface ProfileEntry {
  name: string
  avatarUrl: string | undefined
  ts: number
  resolved: boolean
}

// Bounded — every visited profile would otherwise stay cached for the
// whole session. 200 covers feeds + profile detail visits comfortably.
const cache = new LRUCache<string, ProfileEntry>(200)
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
    const d: ProfileResponse = await res.json()
    // displayName is server-computed (username → farcaster → ens). Fall
    // back to the legacy chain when an older response shape is cached or
    // the server-side enrichment is disabled.
    const name: string =
      d.profile?.displayName || d.profile?.username || d.profile?.ensName || ''
    const avatarUrl: string | undefined = d.profile?.avatarUrl
    const resolved = !!name
    const entry = { name: name || shortAddress(address), avatarUrl, ts: Date.now(), resolved }
    cache.set(key, entry)
    return { name: entry.name, avatarUrl }
  } catch {
    return { name: shortAddress(address), avatarUrl: undefined }
  }
}

// Max addresses per /api/profiles request — mirrors the route cap so the
// client chunks larger sets instead of tripping it.
const BATCH_MAX = 50

// Batch sibling of fetchCreatorProfile: resolves many addresses (e.g. every
// unique sender in a moment's activity thread) in one /api/profiles call
// instead of one /api/profile per address. Shares the same LRU + TTL — cached
// addresses return with no network hit; only misses are fetched.
export async function fetchCreatorProfilesBatch(
  addresses: string[],
): Promise<Record<string, { name: string; avatarUrl: string | undefined }>> {
  const out: Record<string, { name: string; avatarUrl: string | undefined }> = {}
  const misses: string[] = []
  for (const key of new Set(addresses.map((a) => a.toLowerCase()))) {
    const cached = cache.get(key)
    if (cached && Date.now() - cached.ts < (cached.resolved ? TTL_RESOLVED : TTL_FALLBACK)) {
      out[key] = { name: cached.name, avatarUrl: cached.avatarUrl }
    } else {
      misses.push(key)
    }
  }

  // Fetch misses in chunks of BATCH_MAX, each sorted so an identical sender set
  // yields an identical URL → CDN cache hit.
  for (let i = 0; i < misses.length; i += BATCH_MAX) {
    const chunk = misses.slice(i, i + BATCH_MAX).sort()
    try {
      const res = await fetch(`/api/profiles?addresses=${encodeURIComponent(chunk.join(','))}`)
      const { profiles = {} }: { profiles?: Record<string, { name?: string; avatarUrl?: string }> } =
        await res.json()
      for (const key of chunk) {
        const name = profiles[key]?.name || ''
        // Mirror fetchCreatorProfile: shortAddress is the displayed fallback,
        // resolved=false so an unresolved entry re-checks on the short TTL.
        const entry = { name: name || shortAddress(key), avatarUrl: profiles[key]?.avatarUrl, ts: Date.now(), resolved: !!name }
        cache.set(key, entry)
        out[key] = { name: entry.name, avatarUrl: entry.avatarUrl }
      }
    } catch {
      // Non-critical: fall back to shortAddress and don't cache, so a later
      // call retries. Matches fetchCreatorProfile's catch.
      for (const key of chunk) out[key] ??= { name: shortAddress(key), avatarUrl: undefined }
    }
  }
  return out
}
