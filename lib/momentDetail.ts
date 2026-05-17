import { cache } from 'react'
import { INPROCESS_API, type MomentDetail } from './inprocess'
import { isMomentHidden } from './hiddenMoments'
import { getMomentMeta } from './notifications'

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

/**
 * Authoritative creator EOA for moments minted through Kismet. mint-proxy
 * writes this to KV the instant the upstream call lands, so it's available
 * even before inprocess's timeline indexes the new moment.
 *
 * Inprocess /moment often returns the platform smart wallet as
 * creator.address for Kismet-minted moments, and Kismet profiles are
 * keyed by EOA — without this fallthrough, MomentDetailView would look
 * up the wrong address and the creator chip would stay stuck on a
 * shortAddress instead of the user's display name. Shared by the
 * canonical moment page and the intercepting-route overlay so both
 * surfaces resolve to the same EOA.
 */
export const getKvCreatorAddress = cache(async (
  address: string,
  tokenId: string,
): Promise<string | undefined> => {
  try {
    const meta = await getMomentMeta(address, tokenId)
    return meta?.creator
  } catch {
    return undefined
  }
})
