import { getTrackedCollections } from './kv'
import { resolveUri, fetchCollectionMoments } from './inprocess'
import { getHiddenMomentsSet } from './hiddenMoments'
import { getHiddenCollectionsSet } from './hiddenCollections'

export interface MomentSearchResult {
  id: string
  address: string
  tokenId: string
  name: string
  image?: string
  creatorAddress?: string
}

// Tightened from 25 → 10 to keep the fan-out below the browser's
// per-host concurrent-connection cap (~6) and the webview's effective
// limit on slow networks. Doubled the upstream cap would only translate
// to a search-quality gain for users searching deep-catalog mint names,
// which is rare; meanwhile every search paid the latency of the slowest
// collection's response. Reasonable trade.
const MAX_SEARCH_COLLECTIONS = 10
// Per-collection budget for the inprocess /timeline fetch. Anything
// over this is dropped to a [] and the rest of the search continues —
// better to return partial results in <3s than to hang for 10s+ on
// one bad upstream response. Most warm-cache hits return in 50-200ms.
const PER_COLLECTION_TIMEOUT_MS = 2500

export async function searchMoments(query: string): Promise<MomentSearchResult[]> {
  const [allCollections, hiddenMoments, hiddenCollections] = await Promise.all([
    getTrackedCollections(),
    getHiddenMomentsSet(),
    getHiddenCollectionsSet(),
  ])
  // Skip hidden collections at fan-out time so we don't waste upstream
  // requests fetching moments we'd discard. Cap is applied after the skip.
  const collections = allCollections
    .filter((c) => !hiddenCollections.has(c.toLowerCase()))
    .slice(0, MAX_SEARCH_COLLECTIONS)
  // allSettled instead of all so one slow upstream doesn't poison the
  // whole search. fetchCollectionMoments already swallows errors and
  // returns [], so settled is mostly belt-and-suspenders for unexpected
  // throw paths (e.g. AbortError on timeout).
  const settled = await Promise.allSettled(
    collections.map((c) =>
      fetchCollectionMoments(c, {
        revalidate: 30,
        timeoutMs: PER_COLLECTION_TIMEOUT_MS,
      }),
    ),
  )
  const all = settled.map((s) => (s.status === 'fulfilled' ? s.value : []))
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const results: MomentSearchResult[] = []
  for (const moment of all.flat()) {
    if (results.length >= 20) break
    const addr = moment.address.toLowerCase()
    const key = `${addr}:${moment.token_id}`
    if (seen.has(key)) continue
    seen.add(key)
    // Belt-and-suspenders: filter individually-hidden moments, and also
    // hidden collections in case fetchCollectionMoments returned moments
    // whose `address` differs from the queried collection (e.g. proxy/wrap).
    if (hiddenMoments.has(key) || hiddenCollections.has(addr)) continue
    const name = (moment.metadata?.name ?? '').toLowerCase()
    const desc = (moment.metadata?.description ?? '').toLowerCase()
    const creator = (moment.creator?.address ?? '').toLowerCase()
    const creatorName = (moment.creator?.username ?? '').toLowerCase()
    if (name.includes(q) || desc.includes(q) || creator.startsWith(q) || creatorName.includes(q)) {
      results.push({
        id: moment.id ?? key,
        address: moment.address,
        tokenId: moment.token_id,
        name: moment.metadata?.name ?? `#${moment.token_id}`,
        image: moment.metadata?.image ? resolveUri(moment.metadata.image) : undefined,
        creatorAddress: moment.creator?.address,
      })
    }
  }
  return results
}
