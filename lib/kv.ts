import { redis } from './redis'
import { PLATFORM_COLLECTION } from './config'
import { INPROCESS_API } from './inprocess'

// Per-collection set of "authorized creators": addresses an admin
// granted ADMIN to via the post-deploy panel. Stored as JSON-encoded
// objects so we can show the original ENS / EOA the admin typed
// (the on-chain row is the target's smart wallet — we'd otherwise
// have no reverse lookup, since inprocess only resolves
// EOA → smart wallet, not back).
const keyAuthorizedCreators = (collection: string) =>
  `kismetart:authorized-creators:${collection.toLowerCase()}`

// Master tracked set — every contract Kismet has registered. Drives
// timeline fan-out for moment lookups across all scopes.
const KEY = 'kismetart:collections'
// Curator-blessed positive set — Create Collection form deploys plus
// any legacy real collection the curator manually promoted. Source
// of truth for collection-shaped surfaces.
const CREATED_COLLECTIONS_KEY = 'kismetart:created-collections'
// Mints minted via Kismet's MintForm or as a Create Collection cover.
// Members are `<addr>:<tokenId>` strings. Source of truth for the
// Mints feed; the timeline route filters scope=standalone by membership.
const CREATED_MINTS_KEY = 'kismetart:created-mints'

export interface CollectionMeta {
  address: string
  name: string
  image?: string
  description?: string
  artist?: string // lowercased deployer address
}

export type CollectionSource = 'create-form' | 'auto-deploy'
export type CollectionScope = 'standalone' | 'collections' | 'all'

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

// 'collections' returns curated only; 'standalone' and 'all' both
// fan-out to every tracked contract. The timeline route narrows
// 'standalone' post-merge by created-mints membership, so moments
// inside curated collections still reach the Mints feed.
export async function getTrackedCollectionsByScope(
  scope: CollectionScope = 'all',
): Promise<string[]> {
  if (scope === 'collections') return getUserCollections()
  return getTrackedCollections()
}

// "user collections" = the curator-blessed positive set. Used by
// every collection-shaped surface (Collections feed, profile
// collections list, mint dropdown, search, moment-detail chip).
export async function getUserCollections(): Promise<string[]> {
  try {
    return (await redis.smembers(CREATED_COLLECTIONS_KEY)) as string[]
  } catch {
    return []
  }
}

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

export async function addTrackedCollection(
  address: string,
  meta?: Omit<CollectionMeta, 'address'>,
  source: CollectionSource = 'create-form',
): Promise<void> {
  try {
    const ops: Promise<unknown>[] = [redis.sadd(KEY, address)]
    // Auto-deploy wrappers join only KEY — never the curator-blessed
    // set, so they don't surface as collections.
    if (source === 'create-form') {
      ops.push(redis.sadd(CREATED_COLLECTIONS_KEY, address))
    }
    if (meta?.name) {
      const data: CollectionMeta = { ...meta, address: address.toLowerCase() }
      ops.push(redis.set(keyCollectionMeta(address), JSON.stringify(data)))
    }
    await Promise.all(ops)
  } catch (err) {
    // Log instead of swallow — silent KV write failure means the
    // collection never appears in any feed despite a green-toast UI.
    console.error('[kv] addTrackedCollection failed', {
      address,
      hasName: !!meta?.name,
      source,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// Inprocess-indexer-lag fallback for the collection page.
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

// Profile-page fallback when inprocess hasn't indexed a fresh deploy.
// Walks curated only — auto-deploy wrappers belong in the artist's Mints.
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
// shipped. 5min upstream cache bounds the per-search fan-out.
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

// Searches curated collections only; moments have their own search.
export async function searchCollections(query: string): Promise<CollectionMeta[]> {
  const addresses = await getUserCollections()
  if (!addresses.length) return []
  const keys = addresses.map(keyCollectionMeta)
  const raws = await redis.mget<(string | CollectionMeta | null)[]>(...keys)
  const q = query.toLowerCase()
  const results: CollectionMeta[] = []
  for (let i = 0; i < addresses.length; i++) {
    const raw = raws[i]
    if (!raw) continue
    const address = addresses[i].toLowerCase()
    const meta: CollectionMeta = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (meta.name.toLowerCase().includes(q) || address.startsWith(q)) {
      results.push(meta)
      if (results.length >= 20) break
    }
  }
  // Backfill missing cover images from inprocess (scoped to matches).
  return Promise.all(
    results.map(async (meta) => {
      if (meta.image) return meta
      const image = await fetchInprocessCollectionImage(meta.address)
      return image ? { ...meta, image } : meta
    }),
  )
}

export interface AuthorizedCreator {
  /** Lowercased EOA the admin authorized (the input — 0x or resolved
   *  from ENS). The on-chain ADMIN grant is on `smartWallet`; this
   *  field is what we display so the admin sees what they typed. */
  eoa: string
  /** Lowercased inprocess smart wallet for `eoa`. Resolved at grant
   *  time via fetchInprocessSmartWallet — this is the actual on-chain
   *  grantee since MintForm relays through inprocess. */
  smartWallet: string
  /** Optional original-input label (ENS name, e.g. "vitalik.eth").
   *  When set, the list shows this instead of `eoa`. */
  label?: string
  /** EOA of the admin who authorized — kept for an audit trail; the
   *  list UI doesn't surface it today. */
  grantedBy: string
  /** ms epoch — sort newest first when rendering. */
  grantedAt: number
}

export async function addAuthorizedCreator(
  collection: string,
  entry: AuthorizedCreator,
): Promise<void> {
  try {
    await redis.sadd(keyAuthorizedCreators(collection), JSON.stringify(entry))
  } catch (err) {
    console.error('[kv] addAuthorizedCreator failed', {
      collection,
      eoa: entry.eoa,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function removeAuthorizedCreator(
  collection: string,
  eoa: string,
): Promise<void> {
  try {
    const eoaLower = eoa.toLowerCase()
    const members = (await redis.smembers(
      keyAuthorizedCreators(collection),
    )) as string[]
    const matches = members.filter((raw) => {
      try {
        const parsed = JSON.parse(raw) as AuthorizedCreator
        return parsed.eoa.toLowerCase() === eoaLower
      } catch {
        return false
      }
    })
    if (matches.length === 0) return
    await redis.srem(keyAuthorizedCreators(collection), ...matches)
  } catch (err) {
    console.error('[kv] removeAuthorizedCreator failed', {
      collection,
      eoa,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

export async function getAuthorizedCreators(
  collection: string,
): Promise<AuthorizedCreator[]> {
  try {
    const members = (await redis.smembers(
      keyAuthorizedCreators(collection),
    )) as string[]
    const parsed: AuthorizedCreator[] = []
    for (const raw of members) {
      try {
        parsed.push(JSON.parse(raw) as AuthorizedCreator)
      } catch {
        // Drop malformed entries silently; the next grant will
        // overwrite cleanly, and we'd rather show a partial list
        // than throw on the entire collection.
      }
    }
    // Newest first — admins usually want to see what they just
    // authorized at the top of the list.
    return parsed.sort((a, b) => b.grantedAt - a.grantedAt)
  } catch {
    return []
  }
}
