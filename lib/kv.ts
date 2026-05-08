import { redis } from './redis'
import { PLATFORM_COLLECTION } from './config'
import { INPROCESS_API } from './inprocess'

const KEY = 'kismetart:collections'
// Negative marker — auto-deploy wrappers join this set and get excluded
// from collection-shaped surfaces. Legacy entries with no marker default
// to "real collection" without needing a backfill.
const AUTO_DEPLOY_KEY = 'kismetart:auto-deploy-collections'

export interface CollectionMeta {
  address: string
  name: string
  image?: string
  description?: string
  artist?: string // lowercased deployer address
}

export type CollectionSource = 'create-form' | 'auto-deploy'

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

// standalone = PLATFORM + auto-deploy wrappers (functionally one-off mints).
// collections = curated (Create Collection form) only.
// all = unfiltered.
export type CollectionScope = 'standalone' | 'collections' | 'all'

export async function getTrackedCollectionsByScope(
  scope: CollectionScope = 'all',
): Promise<string[]> {
  if (scope === 'all') return getTrackedCollections()
  const [all, autoDeploy] = await Promise.all([
    getTrackedCollections(),
    getAutoDeployCollections(),
  ])
  const auto = new Set(autoDeploy.map((a) => a.toLowerCase()))
  const platform = PLATFORM_COLLECTION.toLowerCase()
  const isCollection = (a: string) => {
    const lower = a.toLowerCase()
    return lower !== platform && !auto.has(lower)
  }
  return scope === 'collections' ? all.filter(isCollection) : all.filter((a) => !isCollection(a))
}

export async function getUserCollections(): Promise<string[]> {
  return getTrackedCollectionsByScope('collections')
}

async function getAutoDeployCollections(): Promise<string[]> {
  try {
    return (await redis.smembers(AUTO_DEPLOY_KEY)) as string[]
  } catch {
    return []
  }
}

export async function addTrackedCollection(
  address: string,
  meta?: Omit<CollectionMeta, 'address'>,
  source: CollectionSource = 'create-form',
): Promise<void> {
  try {
    const ops: Promise<unknown>[] = [redis.sadd(KEY, address)]
    // Auto-deploy wrappers join the marker set; collection-shaped
    // surfaces filter them out.
    if (source === 'auto-deploy') {
      ops.push(redis.sadd(AUTO_DEPLOY_KEY, address))
    }
    if (meta?.name) {
      const data: CollectionMeta = { ...meta, address: address.toLowerCase() }
      ops.push(redis.set(keyCollectionMeta(address), JSON.stringify(data)))
    }
    await Promise.all(ops)
  } catch (err) {
    // Log instead of swallow — a silent KV write failure means the
    // collection never appears in any feed despite a green-toast UI.
    console.error('[kv] addTrackedCollection failed', {
      address,
      hasName: !!meta?.name,
      source,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// Fallback when the inprocess indexer hasn't picked up a fresh deploy.
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

// Fallback for the artist profile page when inprocess hasn't indexed
// a fresh deploy. Walks curated collections only — auto-deploy
// wrappers belong in the artist's Mints feed.
export async function getCollectionsByArtist(
  artist: string
): Promise<CollectionMeta[]> {
  const wanted = artist.toLowerCase()
  const addresses = await getUserCollections()
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

// Cover-image fallback for KV entries registered before the cover flow
// shipped. 5min upstream cache bounds the search-query fan-out cost.
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

// Searches curated collections only; moments have their own search endpoint.
export async function searchCollections(query: string): Promise<CollectionMeta[]> {
  const addresses = await getUserCollections()
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
  // Backfill missing cover images from inprocess. Scoped to matches so
  // latency stays bounded.
  return Promise.all(
    results.map(async (meta) => {
      if (meta.image) return meta
      const image = await fetchInprocessCollectionImage(meta.address)
      return image ? { ...meta, image } : meta
    }),
  )
}
