import { redis } from './redis'
import { PLATFORM_COLLECTION } from './config'
import { inprocessUrl } from './inprocess'
import { getHiddenCollectionsSet } from './hiddenCollections'
import { getHiddenUsersSet } from './hidden-users'
import { memoize } from './memoCache'

// In-memory TTL for the hot collection-set getters below. These read
// SMEMBERS on every request from a wide range of routes (timeline,
// search, featured, collections feed) but the underlying sets change
// rarely — a new collection deploy is once-a-day at most. Every write path
// calls the matching .invalidate() below, so own-pod consistency is
// IMMEDIATE regardless of this TTL; the TTL only governs how often an
// UNCHANGED set is re-read from Upstash. On the current single instance
// that makes a longer window a pure command-cost saving with no staleness
// (there is no other pod to be stale against). 15 min trims the steady-state
// SMEMBERS rate 3× vs the old 5 min. (If this ever runs multi-pod, this is
// also the worst-case cross-pod staleness window — revisit then.)
const SET_CACHE_TTL_MS = 15 * 60_000

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
// of truth for collection-shaped surfaces. Plain SET; the Discover
// feed sorts by inprocess `created_at` (mirrors the Mints pattern).
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
  kismet_thumbhash?: string
  // Token ID minted as the collection cover at deploy time (Kismet
  // create-form flow with mint-cover enabled — currently always '1').
  // The featured-collection row dedupes this token from its mint-card
  // grid so the cover image doesn't render twice (cover card + first
  // mint card). Not used by /collection/[address] — the full
  // collection page is the moment's actual home, so it stays there.
  coverTokenId?: string
  // Deploy-time creation timestamp (ms epoch), stamped by
  // addTrackedCollection. The collection page reads this as a fallback for
  // the "created <date>" chip when inprocess's /collection endpoint doesn't
  // return `created_at`, so the chip survives indexer gaps. Preserved across
  // metadata edits in updateCollectionMeta.
  createdAt?: number
}

export type CollectionSource = 'create-form' | 'auto-deploy'
export type CollectionScope = 'standalone' | 'collections' | 'all'

const keyCollectionMeta = (address: string) =>
  `kismetart:collection-meta:${address.toLowerCase()}`

async function _getTrackedCollections(): Promise<string[]> {
  try {
    const stored = (await redis.smembers(KEY)) as string[]
    const all = new Set([PLATFORM_COLLECTION, ...stored])
    return Array.from(all)
  } catch {
    return [PLATFORM_COLLECTION]
  }
}
export const getTrackedCollections = memoize(_getTrackedCollections, SET_CACHE_TTL_MS)

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
async function _getUserCollections(): Promise<string[]> {
  try {
    return (await redis.smembers(CREATED_COLLECTIONS_KEY)) as string[]
  } catch {
    return []
  }
}
export const getUserCollections = memoize(_getUserCollections, SET_CACHE_TTL_MS)

// Bounded membership check against the created-mints registry — replaces the
// previous full-SMEMBERS → in-memory Set (memoized 15 min). That read grew by
// one member per mint FOREVER and would hard-fail at Upstash's 10MB response
// cap (~200k members), while its only consumer — the timeline's
// scope=standalone filter — only ever needs membership of the current merged
// candidates, never the whole set. SMISMEMBER keeps request AND response
// sized by the candidate count. Chunked so one command's argv stays small;
// same-tick chunks auto-pipeline into a single REST round trip. Exact-match
// caveat: SMISMEMBER does no case normalization server-side, which is safe
// here because markCreatedMint has lowercased the address since its first
// commit and the dataset postdates it (verified via git log -L, 2026-07-13).
//
// No memo layer anymore: every request reads live membership, so a fresh
// mint appears in the Mints feed immediately on every pod (the old memo
// needed an own-pod-only invalidate hook for that).
//
// Failure contract preserved: NO try/catch here — a Redis failure must
// propagate so the caller in app/api/timeline/route.ts skips the filter for
// THIS request (unfiltered moments beat a blank feed; an earlier
// swallow-to-empty-set version blanked the Mints feed for a full cache
// window after every blip).
const SMISMEMBER_CHUNK = 1024
export async function getCreatedMintsMembership(
  candidates: string[],
): Promise<Set<string>> {
  const created = new Set<string>()
  if (candidates.length === 0) return created
  const chunks: string[][] = []
  for (let i = 0; i < candidates.length; i += SMISMEMBER_CHUNK) {
    chunks.push(candidates.slice(i, i + SMISMEMBER_CHUNK))
  }
  const flagChunks = await Promise.all(
    chunks.map((chunk) => redis.smismember(CREATED_MINTS_KEY, chunk)),
  )
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const flags = flagChunks[ci]
    for (let i = 0; i < chunk.length; i++) {
      if (Number(flags[i]) === 1) created.add(chunk[i])
    }
  }
  return created
}

export async function markCreatedMint(address: string, tokenId: string): Promise<void> {
  try {
    // Lowercased address is load-bearing: getCreatedMintsMembership matches
    // members exactly (SMISMEMBER), with candidates built lowercase.
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
      // Stamp a creation timestamp so the collection page can show
      // "created <date>" even before — or without — inprocess indexing the
      // contract's created_at. Preserve any existing stamp so re-registering
      // the same collection never resets its original creation date.
      const existing = await getCollectionMeta(address)
      const createdAt = existing?.createdAt ?? meta.createdAt ?? Date.now()
      const data: CollectionMeta = {
        ...meta,
        address: address.toLowerCase(),
        createdAt,
      }
      ops.push(redis.set(keyCollectionMeta(address), JSON.stringify(data)))
    }
    await Promise.all(ops)
    // Own-pod consistency: the artist who just deployed should see their
    // collection on the next collections-feed read from the same pod
    // immediately. Cross-pod pods catch up on TTL expiry.
    getTrackedCollections.invalidate()
    if (source === 'create-form') getUserCollections.invalidate()
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

/**
 * Overwrite ONLY the CollectionMeta record for an already-tracked collection
 * — used after an on-chain updateContractMetadata edit. Unlike
 * addTrackedCollection this never touches set membership, so editing an
 * auto-deploy collection's metadata can't promote it into the curated
 * CREATED_COLLECTIONS_KEY (and thus the discovery feed).
 */
export async function updateCollectionMeta(
  address: string,
  meta: Omit<CollectionMeta, 'address'>,
): Promise<void> {
  // Preserve the immutable deploy-time creation timestamp across metadata
  // edits — the edit form never sends one, so without this an edit would wipe
  // the "created <date>" the collection page reads back from KV.
  const existing = await getCollectionMeta(address)
  const createdAt = meta.createdAt ?? existing?.createdAt
  const data: CollectionMeta = {
    ...meta,
    address: address.toLowerCase(),
    ...(createdAt ? { createdAt } : {}),
  }
  await redis.set(keyCollectionMeta(address), JSON.stringify(data))
}

/**
 * Backfill a creation timestamp onto an EXISTING tracked collection's meta
 * record, preserving every other field and never touching set membership.
 * For collections deployed before the deploy-time stamp shipped, whose
 * `created_at` the collection page can no longer source from inprocess's
 * (removed) singular endpoint.
 *
 * Returns:
 *  - 'set'        wrote the timestamp
 *  - 'skipped'    a stamp already exists and force was not set (idempotent)
 *  - 'no-record'  no KV meta to merge into — we don't synthesize a partial
 *                 record here, so the caller can report it instead
 */
export async function setCollectionCreatedAt(
  address: string,
  createdAt: number,
  force = false,
): Promise<'set' | 'skipped' | 'no-record'> {
  const existing = await getCollectionMeta(address)
  if (!existing) return 'no-record'
  if (existing.createdAt && !force) return 'skipped'
  const data: CollectionMeta = {
    ...existing,
    address: address.toLowerCase(),
    createdAt,
  }
  await redis.set(keyCollectionMeta(address), JSON.stringify(data))
  return 'set'
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

// Batch variant. Missing addresses (auto-deploy wrappers, non-platform
// contracts) are omitted from the returned map.
export async function getCollectionMetaBatch(
  addresses: string[],
): Promise<Map<string, CollectionMeta>> {
  const out = new Map<string, CollectionMeta>()
  if (addresses.length === 0) return out
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase())))
  try {
    const raws = await redis.mget<(string | CollectionMeta | null)[]>(
      ...unique.map(keyCollectionMeta),
    )
    for (let i = 0; i < unique.length; i++) {
      const raw = raws[i]
      if (!raw) continue
      const parsed: CollectionMeta =
        typeof raw === 'string' ? JSON.parse(raw) : raw
      out.set(unique[i], parsed)
    }
  } catch {}
  return out
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
    const url = inprocessUrl('/collection', { collectionAddress: address, chainId: '8453' })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8_000),
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
  // Three filters compose: hiddenCollections (per-content, creator-controlled),
  // hiddenUsers (per-artist, admin-controlled), and the inline name/address
  // match. All public search surfaces drop hidden-user content unconditionally
  // (search isn't an "own profile" exception surface — see lib/search.ts).
  const [addresses, hiddenCollections, hiddenUsers] = await Promise.all([
    getUserCollections(),
    getHiddenCollectionsSet(),
    getHiddenUsersSet(),
  ])
  if (!addresses.length) return []
  const keys = addresses.map(keyCollectionMeta)
  const raws = await redis.mget<(string | CollectionMeta | null)[]>(...keys)
  const q = query.toLowerCase()
  const results: CollectionMeta[] = []
  for (let i = 0; i < addresses.length; i++) {
    const raw = raws[i]
    if (!raw) continue
    const address = addresses[i].toLowerCase()
    if (hiddenCollections.has(address)) continue
    const meta: CollectionMeta = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (meta.artist && hiddenUsers.has(meta.artist.toLowerCase())) continue
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
  /** Lowercased EOA the admin authorized. Undefined for chain-only
   *  entries — addresses that hold ADMIN on-chain but never came
   *  through our panel (etherscan / foundry grants), discovered by
   *  the GET endpoint's chain merge. UI renders those as "(unmapped)". */
  eoa: string | undefined
  /** Lowercased smart wallet — the on-chain ADMIN grantee. For
   *  KV-tracked entries this is inprocess's resolution of `eoa`;
   *  for chain-only entries it's the address from the log scan. */
  smartWallet: string
  /** Optional ENS label captured at grant time (e.g. "vitalik.eth").
   *  Displayed instead of the address when present. */
  label?: string
  /** EOA of the admin who authorized. Empty string for chain-only
   *  entries — we don't have an audit trail for off-platform grants. */
  grantedBy: string
  /** ms epoch — sort newest first when rendering. 0 for chain-only. */
  grantedAt: number
}

// Upstash's REST SDK auto-deserializes JSON-shaped strings on read,
// so a value written via `redis.sadd(key, JSON.stringify(obj))` comes
// back from `smembers` as the parsed object — not the original string.
// This helper accepts both shapes so legacy KV state and new writes
// both round-trip correctly.
function parseEntry(raw: unknown): AuthorizedCreator | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as AuthorizedCreator
  }
  if (typeof raw === 'string') {
    try {
      const obj = JSON.parse(raw)
      return obj && typeof obj === 'object' ? (obj as AuthorizedCreator) : null
    } catch {
      return null
    }
  }
  return null
}

export async function addAuthorizedCreator(
  collection: string,
  entry: AuthorizedCreator,
): Promise<boolean> {
  if (!entry.eoa) return false
  try {
    // Pass the object directly. The Upstash SDK auto-serializes on
    // write and auto-parses on read, so passing an object keeps SADD/
    // SMEMBERS round-tripping in the same shape. JSON.stringify here
    // would tee up the silent-drop bug fixed by parseEntry below for
    // legacy data, but we don't want to write more of it.
    await redis.sadd(keyAuthorizedCreators(collection), entry)
  } catch (err) {
    console.error('[kv] addAuthorizedCreator failed', {
      collection,
      eoa: entry.eoa,
      err: err instanceof Error ? err.message : String(err),
    })
    return false
  }
  // Best-effort dedupe — if it fails, the panel may briefly show two
  // rows for the same EOA (older + newer) until the next grant cleans
  // them up. The new row above is already persisted at this point.
  try {
    const eoaLower = entry.eoa.toLowerCase()
    const members = (await redis.smembers(
      keyAuthorizedCreators(collection),
    )) as unknown[]
    const stale = members.filter((raw) => {
      const parsed = parseEntry(raw)
      if (!parsed) return false
      // Skip the row we just wrote — match by both EOA and grantedAt
      // so concurrent grants for the same EOA don't drop each other.
      if (
        parsed.eoa?.toLowerCase() === eoaLower &&
        parsed.grantedAt === entry.grantedAt
      ) {
        return false
      }
      return parsed.eoa?.toLowerCase() === eoaLower
    })
    if (stale.length > 0) {
      await redis.srem(keyAuthorizedCreators(collection), ...stale)
    }
  } catch (err) {
    console.error('[kv] addAuthorizedCreator dedupe failed (write succeeded)', {
      collection,
      eoa: entry.eoa,
      err: err instanceof Error ? err.message : String(err),
    })
  }
  return true
}

export async function removeAuthorizedCreator(
  collection: string,
  eoa: string,
): Promise<void> {
  try {
    const eoaLower = eoa.toLowerCase()
    const members = (await redis.smembers(
      keyAuthorizedCreators(collection),
    )) as unknown[]
    const matches = members.filter((raw) => {
      const parsed = parseEntry(raw)
      return parsed?.eoa?.toLowerCase() === eoaLower
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
    )) as unknown[]
    const parsed: AuthorizedCreator[] = []
    for (const raw of members) {
      const entry = parseEntry(raw)
      if (entry) parsed.push(entry)
    }
    // Newest first — admins usually want to see what they just
    // authorized at the top of the list.
    return parsed.sort((a, b) => b.grantedAt - a.grantedAt)
  } catch {
    return []
  }
}
