// Shared in-memory cache for the per-collection metadata fetched from
// /api/collections?address={address}. The endpoint returns a rich shape
// (name + metadata.image) for platform-created (curator-blessed) collections
// and a minimal stub for everything else, so a cached `name === null` means
// "not a platform collection — don't render the chip".
//
// Feeds render many MomentCards from the same collection. Without a shared
// cache each card fires its own /api/collections lookup, which is wasteful
// and produces a perceptible pop-in for the collection chip.

interface CollectionEntry {
  name: string | null
  image: string | null
  ts: number
}

const cache = new Map<string, CollectionEntry>()
const TTL = 5 * 60 * 1000

export interface CollectionChipMeta {
  name: string | null
  image: string | null
}

export async function fetchCollectionChip(address: string): Promise<CollectionChipMeta> {
  const key = address.toLowerCase()
  const cached = cache.get(key)
  if (cached && Date.now() - cached.ts < TTL) {
    return { name: cached.name, image: cached.image }
  }
  try {
    const res = await fetch(`/api/collections?address=${address}`)
    if (!res.ok) {
      const entry = { name: null, image: null, ts: Date.now() }
      cache.set(key, entry)
      return { name: entry.name, image: entry.image }
    }
    const data = await res.json()
    const name: string | null = data.metadata?.name ?? data.name ?? null
    const image: string | null = data.metadata?.image ?? null
    const entry = { name, image, ts: Date.now() }
    cache.set(key, entry)
    return { name, image }
  } catch {
    return { name: null, image: null }
  }
}

// Allow callers (e.g. MomentDetailView with SSR-prefetched KV meta) to seed
// the cache so subsequent renders of the same collection skip the network.
export function seedCollectionChip(address: string, meta: CollectionChipMeta): void {
  const key = address.toLowerCase()
  cache.set(key, { name: meta.name, image: meta.image, ts: Date.now() })
}
