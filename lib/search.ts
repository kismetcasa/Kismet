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

const MAX_SEARCH_COLLECTIONS = 25

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
  const all = await Promise.all(
    collections.map((c) => fetchCollectionMoments(c, { revalidate: 30 })),
  )
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
