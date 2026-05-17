import { cache } from 'react'
import { INPROCESS_API, type MomentDetail } from './inprocess'
import { isMomentHidden } from './hiddenMoments'

/**
 * Server-side moment detail fetch shared by the canonical page and the
 * intercepting-route overlay. Wrapped in React.cache so co-running
 * server components (e.g. canonical page's generateMetadata + render)
 * dedupe to a single upstream call per request.
 *
 * The 60s revalidate is the same window the /api/moment proxy uses, so
 * client and server reads stay consistent on first paint. Hidden state
 * is read uncached from KV alongside the fetch and merged in — same
 * shape /api/moment returns.
 */
export const fetchMomentDetail = cache(async (
  address: string,
  tokenId: string,
): Promise<MomentDetail | null> => {
  try {
    const url = new URL(`${INPROCESS_API}/moment`)
    url.searchParams.set('collectionAddress', address)
    url.searchParams.set('tokenId', tokenId)
    url.searchParams.set('chainId', '8453')
    const [res, hidden] = await Promise.all([
      fetch(url.toString(), { next: { revalidate: 60 } }),
      isMomentHidden(address, tokenId),
    ])
    if (!res.ok) return null
    const data = (await res.json()) as MomentDetail
    return { ...data, hidden }
  } catch {
    return null
  }
})
