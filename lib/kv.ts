import { redis } from './redis'
import { PLATFORM_COLLECTION } from './config'
import { INPROCESS_API } from './inprocess'

const KEY = 'kismetart:collections'
// Marker set: addresses we've registered as auto-deployed wrappers. The
// rule is "every tracked entry counts as a curated collection UNLESS it's
// in this set." That polarity preserves legacy entries (registered before
// this flag existed, no marker) — they default to "real collection" and
// keep working in the Collections feed, profile collections list, mint
// dropdown picker, etc. New auto-deploy registrations explicitly join
// this set and get excluded from collection-shaped surfaces.
const AUTO_DEPLOY_KEY = 'kismetart:auto-deploy-collections'

export interface CollectionMeta {
  address: string
  name: string
  image?: string
  description?: string
  artist?: string // lowercased deployer address
}

/** How a collection was registered. Drives whether it appears in
 *  collection-shaped surfaces (Collections feed, profile collections list,
 *  moment-detail collection chip) or is treated as a standalone wrapper. */
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

/**
 * Filter the tracked set by discovery scope. `standalone` keeps the shared
 * platform contract (where one-off mints live) PLUS auto-deployed wrapper
 * collections — both are functionally individual mints. `collections` keeps
 * only collections explicitly registered via the Create Collection form.
 * `all` is the unfiltered list, used by surfaces that mix both kinds (the
 * roster tab, profile feeds, the airdrop picker).
 */
export type CollectionScope = 'standalone' | 'collections' | 'all'

export async function getTrackedCollectionsByScope(
  scope: CollectionScope = 'all',
): Promise<string[]> {
  if (scope === 'all') return getTrackedCollections()
  if (scope === 'collections') return getUserCollections()
  // standalone: tracked minus the curated-collection set
  // (= PLATFORM_COLLECTION + every auto-deployed wrapper). Computing the
  // difference here keeps a single source of truth for what counts as a
  // collection and means we never have to write PLATFORM_COLLECTION into
  // any auxiliary set just to filter it back out.
  const [all, userCreated] = await Promise.all([
    getTrackedCollections(),
    getUserCollections(),
  ])
  const userSet = new Set(userCreated.map((a) => a.toLowerCase()))
  return all.filter((a) => !userSet.has(a.toLowerCase()))
}

/**
 * Addresses that count as collections in the curatorial sense — every
 * tracked address that is NOT explicitly marked as an auto-deploy wrapper
 * AND is not the shared platform contract. Legacy entries (registered
 * before the auto-deploy marker existed) flow through as collections by
 * default, so a user who already has Create Collection deploys keeps
 * seeing them in the Collections feed and the mint-dropdown picker.
 *
 * Empty on Redis errors so a transient outage surfaces as an empty feed
 * instead of accidentally exposing the marker set's contents.
 */
export async function getUserCollections(): Promise<string[]> {
  try {
    const [all, autoDeploy] = await Promise.all([
      getTrackedCollections(),
      getAutoDeployCollections(),
    ])
    const auto = new Set(autoDeploy.map((a) => a.toLowerCase()))
    const platform = PLATFORM_COLLECTION.toLowerCase()
    return all.filter((a) => {
      const lower = a.toLowerCase()
      return lower !== platform && !auto.has(lower)
    })
  } catch {
    return []
  }
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
    // Auto-deployed wrappers are NOT collections in the curatorial sense —
    // they're individual mints whose contract happens to be unique. The
    // protocol creates them on first-mint when no collection is picked.
    // Mark them in AUTO_DEPLOY_KEY so collection-shaped surfaces filter
    // them out. Default ('create-form') writes nothing to the marker set,
    // which means legacy entries (registered before this flag existed)
    // also default to "real collection" without needing a backfill.
    if (source === 'auto-deploy') {
      ops.push(redis.sadd(AUTO_DEPLOY_KEY, address))
    }
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
      source,
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
// indexed a freshly-deployed collection yet. Walks the curated-collection
// set (every tracked entry minus PLATFORM and minus auto-deploy markers)
// so auto-deployed mint wrappers stay out of the artist's "Collections"
// surface — those belong in their Mints feed.
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
  // Search ranges over the curated-collection set — auto-deployed wrappers
  // (whose name is just the moment title) shouldn't surface as collection
  // search results. Moment search has its own endpoint; this is strictly
  // for curated
  // collections.
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
