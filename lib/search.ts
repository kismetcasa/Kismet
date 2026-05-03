import { getTrackedCollections } from './kv'
import { resolveUri, fetchCollectionMoments } from './inprocess'

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
  const allCollections = await getTrackedCollections()
  const collections = allCollections.slice(0, MAX_SEARCH_COLLECTIONS)
  // Search hits a fresher cache (30s) than the collection page's full render
  // (60s default) since search results should reflect new mints quickly.
  const all = await Promise.all(
    collections.map((c) => fetchCollectionMoments(c, { revalidate: 30 })),
  )
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const results: MomentSearchResult[] = []
  for (const moment of all.flat()) {
    if (results.length >= 20) break
    const key = `${moment.address}:${moment.token_id}`
    if (seen.has(key)) continue
    seen.add(key)
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
