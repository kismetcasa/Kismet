import { redis } from './redis'
import { PLATFORM_COLLECTION } from './config'
import { INPROCESS_API } from './inprocess'

const KEY = 'kismetart:collections'

export interface CollectionMeta {
  address: string
  name: string
  image?: string
  description?: string
  artist?: string // lowercased deployer address
}

const keyCollectionMeta = (address: string) =>
  `kismetart:collection-meta:${address.toLowerCase()}`

export async function getTrackedCollections(): Promise<string[]> {
  try {
    const stored = (await redis.smembers(KEY)) as string[]
    const all = new Set([PLATFORM_COLLECTION, ...stored])
    return Array.from(all)
  } catch {
    return [PLATFORM_COLLECTION]
  }
}

/**
 * Filter the tracked set by discovery scope. `standalone` keeps only the
 * shared platform contract (where one-off mints live); `collections` keeps
 * only user-deployed collections; `all` is the unfiltered list. The split
 * is keyed on PLATFORM_COLLECTION because every moment unambiguously lives
 * at exactly one (collection_address, token_id) pair — either it's on the
 * platform contract or in a user collection.
 */
export type CollectionScope = 'standalone' | 'collections' | 'all'

export async function getTrackedCollectionsByScope(
  scope: CollectionScope = 'all',
): Promise<string[]> {
  const all = await getTrackedCollections()
  if (scope === 'all') return all
  const platformLower = PLATFORM_COLLECTION.toLowerCase()
  return scope === 'standalone'
    ? all.filter((a) => a.toLowerCase() === platformLower)
    : all.filter((a) => a.toLowerCase() !== platformLower)
}

export async function addTrackedCollection(
  address: string,
  meta?: Omit<CollectionMeta, 'address'>
): Promise<void> {
  try {
    const ops: Promise<unknown>[] = [redis.sadd(KEY, address)]
    if (meta?.name) {
      const data: CollectionMeta = { ...meta, address: address.toLowerCase() }
      ops.push(redis.set(keyCollectionMeta(address), JSON.stringify(data)))
    }
    await Promise.all(ops)
  } catch (err) {
    // Surface in Vercel function logs instead of swallowing — if Upstash
    // is unreachable or misconfigured, a brand-new deploy silently won't
    // show up in any feed and the user gets a misleading green toast.
    console.error('[kv] addTrackedCollection failed', {
      address,
      hasName: !!meta?.name,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// Used by the collection page as a fallback when inprocess hasn't indexed
// a freshly-deployed collection yet. Returns null if Redis isn't configured
// or no metadata was stored at deploy time.
export async function getCollectionMeta(
  address: string
): Promise<CollectionMeta | null> {
  try {
    const raw = await redis.get<string | CollectionMeta | null>(
      keyCollectionMeta(address)
    )
    if (!raw) return null
    return typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return null
  }
}

// Used by the artist's profile page as a fallback when inprocess hasn't
// indexed a freshly-deployed collection yet. Walks the tracked set, fetches
// stored metadata, and filters by deployer address.
export async function getCollectionsByArtist(
  artist: string
): Promise<CollectionMeta[]> {
  const wanted = artist.toLowerCase()
  const addresses = await getTrackedCollections()
  if (!addresses.length) return []
  const keys = addresses.map(keyCollectionMeta)
  try {
    const raws = await redis.mget<(string | CollectionMeta | null)[]>(...keys)
    const out: CollectionMeta[] = []
    for (const raw of raws) {
      if (!raw) continue
      const meta: CollectionMeta = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (meta.artist?.toLowerCase() === wanted) out.push(meta)
    }
    return out
  } catch {
    return []
  }
}

// Fetches a collection's image from inprocess as a fallback for KV entries
// that were registered before the cover-image flow shipped (or whose
// image upload happened after the KV write). Bounded 5min cache so a
// single search query doesn't fan out repeated upstream calls.
async function fetchInprocessCollectionImage(address: string): Promise<string | undefined> {
  try {
    const url = new URL(`${INPROCESS_API}/collection`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('chainId', '8453')
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 300 },
    })
    if (!res.ok) return undefined
    const text = await res.text()
    if (!text) return undefined
    const data = JSON.parse(text) as { metadata?: { image?: string } }
    return typeof data?.metadata?.image === 'string' ? data.metadata.image : undefined
  } catch {
    return undefined
  }
}

export async function searchCollections(query: string): Promise<CollectionMeta[]> {
  const addresses = await getTrackedCollections()
  if (!addresses.length) return []
  const keys = addresses.map(keyCollectionMeta)
  const raws = await redis.mget<(string | CollectionMeta | null)[]>(...keys)
  const q = query.toLowerCase()
  const results: CollectionMeta[] = []
  for (let i = 0; i < addresses.length; i++) {
    const raw = raws[i]
    if (!raw) continue // skip auto-tracked collections without an explicit name
    const address = addresses[i].toLowerCase()
    const meta: CollectionMeta = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (meta.name.toLowerCase().includes(q) || address.startsWith(q)) {
      results.push(meta)
      if (results.length >= 20) break
    }
  }
  // Backfill any matches missing a cover image from inprocess. Scoped to
  // the matched results so latency stays bounded; 5min upstream cache
  // (see fetchInprocessCollectionImage) keeps the cost flat across
  // repeated searches.
  return Promise.all(
    results.map(async (meta) => {
      if (meta.image) return meta
      const image = await fetchInprocessCollectionImage(meta.address)
      return image ? { ...meta, image } : meta
    }),
  )
}
