import { getTrackedCollections } from './kv'
import { fetchCollectionMoments } from './inprocess'
import { getHiddenMomentsSet } from './hiddenMoments'
import { getHiddenCollectionsSet } from './hiddenCollections'
import { getHiddenUsersSet } from './hidden-users'
import { foldSearch, rankScore, RANK } from './searchText'

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
  const [allCollections, hiddenMoments, hiddenCollections, hiddenUsers] = await Promise.all([
    getTrackedCollections(),
    getHiddenMomentsSet(),
    getHiddenCollectionsSet(),
    getHiddenUsersSet(),
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
  // Fold both sides so an ASCII query matches accented titles / creator handles,
  // and score every candidate so the best matches survive the 20-result cap
  // (the old first-20-scanned break dropped better matches found later).
  const fq = foldSearch(query)
  const seen = new Set<string>()
  const scored: { r: MomentSearchResult; score: number }[] = []
  for (const moment of all.flat()) {
    const addr = moment.address.toLowerCase()
    const key = `${addr}:${moment.token_id}`
    if (seen.has(key)) continue
    seen.add(key)
    // Belt-and-suspenders: filter individually-hidden moments, hidden
    // collections (in case fetchCollectionMoments returned moments whose
    // `address` differs from the queried collection), and moments whose
    // creator is on the admin-hidden-users list.
    if (hiddenMoments.has(key) || hiddenCollections.has(addr)) continue
    const creatorLower = (moment.creator?.address ?? '').toLowerCase()
    if (creatorLower && hiddenUsers.has(creatorLower)) continue
    const nameScore = rankScore(moment.metadata?.name, fq)
    const creatorNameScore = rankScore(moment.creator?.username, fq)
    const creatorAddrScore = fq && creatorLower.startsWith(fq) ? RANK.PREFIX : RANK.NONE
    // Description is a weak signal — count it only as a substring hit, never a
    // "top" match, so a stray word in a long description can't outrank a title.
    const descScore = rankScore(moment.metadata?.description, fq) > 0 ? RANK.SUBSTRING : RANK.NONE
    const tier = Math.max(nameScore, creatorNameScore, creatorAddrScore, descScore)
    if (tier === 0) continue
    scored.push({
      r: {
        id: moment.id ?? key,
        address: moment.address,
        tokenId: moment.token_id,
        name: moment.metadata?.name ?? `#${moment.token_id}`,
        // Raw ar://|ipfs:// URI, NOT a resolved gateway URL. MomentImage
        // resolves it internally for the optimizer path (identical render for
        // light images) but — critically — only a RAW proxiable URI can route
        // through /api/img's downscale+disk-cache. A pre-resolved https URL is
        // not proxiable, so a heavy Patron scan fell to 'direct' mode and the
        // search thumbnail re-downloaded the full >50MB original every time.
        image: moment.metadata?.image,
        creatorAddress: moment.creator?.address,
      },
      // Title matches outrank creator/description matches at the same tier.
      score: tier * 2 + (nameScore >= tier ? 1 : 0),
    })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 20).map((s) => s.r)
}
