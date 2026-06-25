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

// Max addresses per /api/profiles request — mirrors the route's own cap so
// the client never trips the 400 and instead chunks larger sets.
const BATCH_MAX = 50

// Batch variant of fetchCreatorProfile for resolving many addresses at once
// (e.g. every unique sender in a moment's activity thread). Shares the same
// LRU + TTL semantics — already-cached addresses are returned without a
// network hit, and only the misses are fetched, in a single /api/profiles
// call (chunked at BATCH_MAX). Replaces the prior N parallel
// fetchCreatorProfile round-trips (one per sender) with one request.
export async function fetchCreatorProfilesBatch(
  addresses: string[],
): Promise<Record<string, { name: string; avatarUrl: string | undefined }>> {
  const out: Record<string, { name: string; avatarUrl: string | undefined }> = {}
  const misses: string[] = []
  for (const address of addresses) {
    const key = address.toLowerCase()
    if (out[key] || misses.includes(key)) continue // dedupe within the call
    const cached = cache.get(key)
    if (cached) {
      const ttl = cached.resolved ? TTL_RESOLVED : TTL_FALLBACK
      if (Date.now() - cached.ts < ttl) {
        out[key] = { name: cached.name, avatarUrl: cached.avatarUrl }
        continue
      }
    }
    misses.push(key)
  }
  if (misses.length === 0) return out

  // Chunk to the route cap and fetch chunks in parallel. Sort each chunk so
  // an identical sender set yields an identical URL → CDN cache hit.
  const chunks: string[][] = []
  for (let i = 0; i < misses.length; i += BATCH_MAX) {
    chunks.push(misses.slice(i, i + BATCH_MAX))
  }
  await Promise.all(
    chunks.map(async (chunk) => {
      const param = chunk.slice().sort().join(',')
      try {
        const res = await fetch(`/api/profiles?addresses=${encodeURIComponent(param)}`)
        const data: { profiles?: Record<string, { name?: string; avatarUrl?: string }> } =
          await res.json()
        const resolved = data.profiles ?? {}
        for (const key of chunk) {
          const p = resolved[key]
          const name = p?.name || ''
          const avatarUrl = p?.avatarUrl
          // Mirror fetchCreatorProfile: store shortAddress as the displayed
          // fallback, flag `resolved` off so it re-checks on the short TTL.
          const entry = { name: name || shortAddress(key), avatarUrl, ts: Date.now(), resolved: !!name }
          cache.set(key, entry)
          out[key] = { name: entry.name, avatarUrl }
        }
      } catch {
        // Non-critical: fall back to shortAddress for this chunk and don't
        // cache, so a later call retries. Matches fetchCreatorProfile's catch.
        for (const key of chunk) {
          if (!out[key]) out[key] = { name: shortAddress(key), avatarUrl: undefined }
        }
      }
    }),
  )
  return out
}
