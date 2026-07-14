import { inprocessUrl, type Moment } from './inprocess'
import { getTrackedCollections } from './kv'
import { getMomentMetaBatch } from './notifications'
import { resolveMomentCreator } from './statsMath'
import { synthesizeMissingCoverMoment } from './coverMomentSynthesis'
import { getSmartWalletOwners } from './smartWalletCache'
import { redis } from './redis'

// Platform catalog census: how many distinct ARTWORKS have been minted and by
// how many distinct ARTISTS — the creation-side companion to the sales-side
// roll-up the stats rebuild snapshots (lib/stats.ts PLATFORM_SALES_KEY). The
// sales figures come from the /transfers feed and therefore only see PAID
// activity; a census over the tracked-collection catalog is the only way to
// count free mints, unsold work, and artists who haven't sold yet.
//
// Sourcing mirrors the feed exactly: the same per-collection inprocess
// /timeline read the timeline route fans out (including the synthesized
// cover-mints inprocess's indexer misses), the same KV creator override
// (resolveMomentCreator — so a delegated mint into a curated collection is
// credited to the ARTIST, not the collection owner), and the same
// smart-wallet→EOA fold the stats rebuild applies. HIDDEN moments/collections/
// users are deliberately INCLUDED: hiding is a display concern; the census
// counts what was minted, not what is currently shown.
//
// Failure semantics: a collection whose FIRST page can't be read aborts the
// whole census (throw) — an absolute counter must not silently shrink because
// the upstream was sick mid-scan; the next cron run retries (the same
// abort-don't-overwrite stance as rebuildStats). A failure on a LATER page of
// an already-partially-read collection only stops that collection's walk and
// is surfaced in `pageFailures`/`possiblyTruncated`, so a transient blip
// degrades one collection's depth measurably instead of zeroing the run.
const CATALOG_KEY = 'kismetart:stats:platform:catalog'

// Page size matches the per-collection depth the timeline fan-out has
// historically pulled from inprocess without issue; the page cap bounds a
// single collection's walk (cap × limit = 4,000 moments) so one pathological
// collection can't pin the census. Collections at the cap are counted in
// `possiblyTruncated` rather than silently under-reported.
const CENSUS_PAGE_LIMIT = 200
const CENSUS_MAX_PAGES = 20
// Gentler than the feed's 10-wide fan-out — this is an hourly cron sharing
// the single upstream with live traffic, not a user waiting on a response.
const CENSUS_CONCURRENCY = 6

export interface CatalogCensus {
  updatedAt: number
  /** Distinct artworks (collection:tokenId pairs) across tracked contracts. */
  artworks: number
  /** Distinct creators of those artworks (KV override + smart-wallet fold). */
  artists: number
  /** Tracked contracts scanned (after case-dedup). */
  collections: number
  /** Collections whose walk hit the page cap or lost a later page — their
   *  moment counts are lower bounds. */
  possiblyTruncated: number
  /** Later-page reads that failed (page 1 failures abort the census). */
  pageFailures: number
  /** Artworks with no resolvable creator — counted in `artworks`, absent
   *  from `artists`. */
  unattributed: number
}

// Same bounded-concurrency map as the timeline route's fan-out (kept local
// there too) — a plain Promise.all over every tracked collection would open
// one upstream socket per collection simultaneously.
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker)
  await Promise.all(workers)
  return results
}

// One strictly-validated page, or null on ANY failure (non-2xx, bad shape,
// timeout) — the caller must be able to tell "empty collection" from "read
// failed", exactly the distinction lib/inprocessTransfers.ts draws for the
// stats rebuild. fetchCollectionMoments deliberately blurs it (feeds degrade
// to empty), which is why the census doesn't reuse it.
async function fetchCensusPage(collection: string, page: number): Promise<Moment[] | null> {
  try {
    const res = await fetch(
      inprocessUrl('/timeline', {
        collection,
        limit: CENSUS_PAGE_LIMIT,
        page,
        chain_id: '8453',
      }),
      {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(8_000),
      },
    )
    if (!res.ok) return null
    const data = (await res.json()) as { moments?: unknown }
    if (!Array.isArray(data.moments)) return null
    return data.moments as Moment[]
  } catch {
    return null
  }
}

interface CollectionWalk {
  moments: Moment[]
  truncated: boolean
  pageFailures: number
}

// Walk one collection's timeline to (bounded) completion. Dedup by
// collection:tokenId inside the walk so an upstream that IGNORES the `page`
// param (docs are thin) returns identical rows on page 2, adds nothing new,
// and cleanly ends the walk with everything counted exactly once.
async function walkCollection(collection: string): Promise<CollectionWalk | null> {
  const moments: Moment[] = []
  const seen = new Set<string>()
  let truncated = false
  let pageFailures = 0
  for (let page = 1; page <= CENSUS_MAX_PAGES; page++) {
    const rows = await fetchCensusPage(collection, page)
    if (rows === null) {
      if (page === 1) return null // unreadable collection → abort the census
      pageFailures++
      truncated = true
      break
    }
    let added = 0
    for (const m of rows) {
      const key = `${(m.address ?? collection).toLowerCase()}:${m.token_id}`
      if (seen.has(key)) continue
      seen.add(key)
      moments.push(m)
      added++
    }
    if (rows.length < CENSUS_PAGE_LIMIT) break // real end of the timeline
    if (added === 0) break // full page, nothing new → upstream ignored `page`
    if (page === CENSUS_MAX_PAGES) truncated = true // cap hit while still full
  }
  // Cover-mints deployed via factory setupAction never enter inprocess's
  // /timeline index — merge the synthesized entry so the census matches what
  // the feed (and the chain) actually contain. Never throws; null = no-op.
  const cover = await synthesizeMissingCoverMoment(collection, moments)
  if (cover) moments.push(cover)
  return { moments, truncated, pageFailures }
}

/**
 * Rebuild the catalog census from inprocess and persist it. Throws on an
 * unreadable collection (abort-don't-overwrite); the cron route logs and the
 * previous snapshot stays live. Call from the sync-stats cron, or once to
 * backfill.
 */
export async function rebuildCatalogCensus(): Promise<CatalogCensus> {
  // Case-dedup so a checksummed and lowercased registration of the same
  // contract can't be walked (and counted) twice.
  const collections = [...new Set((await getTrackedCollections()).map((c) => c.toLowerCase()))]

  const walks = await mapWithConcurrency(collections, CENSUS_CONCURRENCY, walkCollection)
  const failed = walks.reduce((n, w) => n + (w === null ? 1 : 0), 0)
  if (failed > 0) {
    throw new Error(
      `catalog census aborted: ${failed}/${collections.length} collection(s) unreadable — ` +
        'refusing to overwrite with a partial count',
    )
  }

  // Cross-collection dedup: the per-walk sets already dedup within a
  // collection; this guards a moment surfacing under two tracked entries.
  const seen = new Set<string>()
  const moments: Moment[] = []
  for (const walk of walks as CollectionWalk[]) {
    for (const m of walk.moments) {
      const key = `${m.address?.toLowerCase()}:${m.token_id}`
      if (seen.has(key)) continue
      seen.add(key)
      moments.push(m)
    }
  }

  // Creator attribution — the SAME precedence every other surface uses
  // (lib/statsMath resolveMomentCreator): the KV minter EOA persisted at mint
  // time beats inprocess's attribution (which reports the platform smart
  // wallet / collection defaultAdmin for delegated and cover mints). One
  // internally-chunked MGET for the whole set.
  const metas = await getMomentMetaBatch(
    moments.map((m) => ({ address: m.address, tokenId: m.token_id })),
  )
  const creators: string[] = []
  let unattributed = 0
  moments.forEach((m, i) => {
    const resolved = resolveMomentCreator({
      kvCreator: metas[i]?.creator ?? null,
      feedCreator: m.creator?.address,
    })
    if (resolved.address) creators.push(resolved.address.toLowerCase())
    else unattributed++
  })

  // Smart-wallet→EOA fold, mirroring the stats rebuild: inprocess attributes
  // relayed mints to the per-creator smart wallet, which is the same artist
  // as the owning EOA — counting both would double-count them.
  const uniqueCreators = [...new Set(creators)]
  const remap = await getSmartWalletOwners(uniqueCreators)
  const artists = new Set(uniqueCreators.map((c) => remap.get(c) ?? c)).size

  const census: CatalogCensus = {
    updatedAt: Date.now(),
    artworks: moments.length,
    artists,
    collections: collections.length,
    possiblyTruncated: walks.reduce(
      (n, w) => n + ((w as CollectionWalk).truncated ? 1 : 0),
      0,
    ),
    pageFailures: walks.reduce((n, w) => n + ((w as CollectionWalk).pageFailures ?? 0), 0),
    unattributed,
  }
  // Loud on failure (throw → cron logs it): a swallowed write here would
  // silently serve a stale census for an hour with nothing in the logs.
  await redis.set(CATALOG_KEY, census)
  return census
}

/** The persisted census, or null before the first successful run / on a
 *  Redis blip — callers surface "not computed yet" instead of a fake zero. */
export async function getCatalogCensus(): Promise<CatalogCensus | null> {
  try {
    const raw = await redis.get<CatalogCensus | string | null>(CATALOG_KEY)
    if (!raw) return null
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as CatalogCensus) : raw
    return typeof parsed?.updatedAt === 'number' ? parsed : null
  } catch {
    return null
  }
}
