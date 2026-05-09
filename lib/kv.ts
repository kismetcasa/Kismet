import { redis } from './redis'
import { PLATFORM_COLLECTION } from './config'
import { INPROCESS_API } from './inprocess'

const KEY = 'kismetart:collections'
// Positive tracking — populated at form-submission time, not derived.
// CREATED_COLLECTIONS_KEY is the curator's source of truth for "what
// counts as a real collection". CREATED_MINTS_KEY is the same for
// individual mints. Anything not in these sets isn't recognized.
const CREATED_COLLECTIONS_KEY = 'kismetart:created-collections'
const CREATED_MINTS_KEY = 'kismetart:created-mints'
// Cover tokens (tokenId minted during Create Collection deploy when the
// "mint cover" toggle is on). Members are `<addr>:<tokenId>` strings.
// Filtered out of every Mints surface so collection cover art doesn't
// appear as a standalone mint card.
const COVER_MOMENTS_KEY = 'kismetart:cover-moments'

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

// 'collections' returns curated only (Create Collection deploys).
// 'standalone' and 'all' fan-out to every tracked contract; the
// timeline route narrows 'standalone' post-merge by created-mints
// membership, so moments inside curated collections (from MintForm
// or cover-mint) still reach the Mints feed.
export type CollectionScope = 'standalone' | 'collections' | 'all'

export async function getTrackedCollectionsByScope(
  scope: CollectionScope = 'all',
): Promise<string[]> {
  if (scope === 'collections') return getCreatedCollections()
  return getTrackedCollections()
}

// Curator-blessed set: contracts deployed via the Create Collection form,
// plus any legacy real collection the curator manually promoted.
export async function getCreatedCollections(): Promise<string[]> {
  try {
    return (await redis.smembers(CREATED_COLLECTIONS_KEY)) as string[]
  } catch {
    return []
  }
}

export async function markCreatedCollection(address: string): Promise<void> {
  try {
    // Write to both the master tracked set (so timeline fan-outs include
    // it) and the curator-blessed positive set (so collection-shaped
    // surfaces render it). markCreatedCollection is the legacy-promote
    // entry point — addTrackedCollection handles the going-forward path
    // and writes the same two keys via its own logic.
    await Promise.all([
      redis.sadd(KEY, address),
      redis.sadd(CREATED_COLLECTIONS_KEY, address),
    ])
  } catch (err) {
    console.error('[kv] markCreatedCollection failed', { address, err })
  }
}

export async function unmarkCreatedCollection(address: string): Promise<boolean> {
  try {
    const removed = await redis.srem(CREATED_COLLECTIONS_KEY, address)
    return Number(removed) > 0
  } catch {
    return false
  }
}

// Mints minted via Kismet's MintForm. Members are `<addr>:<tokenId>`.
export async function getCreatedMintsSet(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(CREATED_MINTS_KEY)) as string[]
    return new Set(members.map((m) => m.toLowerCase()))
  } catch {
    return new Set()
  }
}

export async function markCreatedMint(address: string, tokenId: string): Promise<void> {
  try {
    await redis.sadd(CREATED_MINTS_KEY, `${address.toLowerCase()}:${tokenId}`)
  } catch (err) {
    console.error('[kv] markCreatedMint failed', { address, tokenId, err })
  }
}

// Backward-compat alias — existing call sites read "collections in the
// curatorial sense" through this name. Now resolves to created-collections.
export async function getUserCollections(): Promise<string[]> {
  return getCreatedCollections()
}

export async function getCoverMomentsSet(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(COVER_MOMENTS_KEY)) as string[]
    return new Set(members.map((m) => m.toLowerCase()))
  } catch {
    return new Set()
  }
}

export async function markCoverMoment(address: string, tokenId: string): Promise<void> {
  try {
    await redis.sadd(COVER_MOMENTS_KEY, `${address.toLowerCase()}:${tokenId}`)
  } catch {
    /* non-critical — cover will leak into Mints feed but no other harm */
  }
}

export async function addTrackedCollection(
  address: string,
  meta?: Omit<CollectionMeta, 'address'>,
  source: CollectionSource = 'create-form',
): Promise<void> {
  try {
    const ops: Promise<unknown>[] = [redis.sadd(KEY, address)]
    // Create Collection form deploys join the curator-blessed positive
    // set. Auto-deploy wrappers (MintForm without selection) skip it —
    // the contract still tracks for moment fan-out, but it never
    // surfaces as a collection.
    if (source === 'create-form') {
      ops.push(redis.sadd(CREATED_COLLECTIONS_KEY, address))
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
