import { inprocessUrl, type Moment } from './inprocess'
import { getTrackedCollections } from './kv'
import { getMomentMetaBatch } from './notifications'
import { resolveMomentCreator } from './statsMath'
import { synthesizeMissingCoverMoment } from './coverMomentSynthesis'
import { getSmartWalletOwners } from './smartWalletCache'
import { getHiddenMomentsSet } from './hiddenMoments'
import { getHiddenCollectionsSet } from './hiddenCollections'
import { getHiddenUsersSet } from './hidden-users'
import { PATRON_COLLECTION_ADDRESS } from './patronCollection'
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
// users are deliberately INCLUDED in the totals — hiding is a display
// concern; the census counts what was minted — and separately COUNTED in
// `hidden`, so both readings are available (public-visible = artworks−hidden).
// The Patron/Mint-Pass collection is excluded: passes are not artworks (pass
// activity has its own block in the sales snapshot).
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
  /** Distinct ARTWORKS (collection:tokenId pairs) across tracked contracts.
   *  TOTAL including hidden work; excludes the Patron/Mint-Pass collection —
   *  passes are not artworks (they get their own block in the sales
   *  snapshot). */
  artworks: number
  /** Artworks in `artworks` that are hidden from public feeds: moment-hidden,
   *  inside a hidden collection, or by an admin-hidden creator — the same
   *  three filters the timeline applies. Publicly visible = artworks−hidden. */
  hidden: number
  /** Distinct creators of those artworks (KV override + smart-wallet fold). */
  artists: number
  /** Tracked contracts scanned (after case-dedup; patron excluded). */
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
  // contract can't be walked (and counted) twice. The Patron/Mint-Pass
  // collection is excluded up front: passes are not artworks (its side
  // conveniently also keeps the platform treasury — the pass "creator" —
  // out of the artist count).
  const collections = [
    ...new Set((await getTrackedCollections()).map((c) => c.toLowerCase())),
  ].filter((c) => c !== PATRON_COLLECTION_ADDRESS)

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
  // internally-chunked MGET for the whole set. The hidden sets ride the same
  // round trip: `hidden` counts artworks the public feeds suppress, using the
  // timeline's exact three filters (moment-hidden, hidden collection,
  // admin-hidden creator) against the SAME resolved creator, so "visible on
  // the feed" and "artworks − hidden" can't disagree.
  const [metas, hiddenSet, hiddenColls, hiddenUsers] = await Promise.all([
    getMomentMetaBatch(moments.map((m) => ({ address: m.address, tokenId: m.token_id }))),
    getHiddenMomentsSet(),
    getHiddenCollectionsSet(),
    getHiddenUsersSet(),
  ])
  const creators: string[] = []
  let unattributed = 0
  let hidden = 0
  moments.forEach((m, i) => {
    const resolved = resolveMomentCreator({
      kvCreator: metas[i]?.creator ?? null,
      feedCreator: m.creator?.address,
    })
    const creator = resolved.address?.toLowerCase()
    if (creator) creators.push(creator)
    else unattributed++
    const addr = m.address?.toLowerCase() ?? ''
    if (
      hiddenSet.has(`${addr}:${m.token_id}`) ||
      hiddenColls.has(addr) ||
      (creator ? hiddenUsers.has(creator) : false)
    ) {
      hidden++
    }
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
    hidden,
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
