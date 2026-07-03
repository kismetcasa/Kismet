import { cache } from 'react'
import type { Address } from 'viem'
import { inprocessUrl, type MomentDetail } from './inprocess'
import { isMomentHidden } from './hiddenMoments'
import { getMomentMeta } from './notifications'
import { resolveCanonicalProfile } from './addressUnion'
import { onchainSaleConfigFallback } from './saleConfig'
import { serverBaseClient } from './rpc'

/**
 * Look up a token's creator via the inprocess timeline endpoint, which
 * has a dedicated `creator` field. Necessary because /moment only
 * exposes momentAdmins (an unordered list of platform admins, smart
 * wallets, and the actual creator) — position [0] is NOT reliably the
 * minter. Exported so the /api/moment route and the OG-image route
 * share one implementation.
 */
export async function fetchCreatorFromTimeline(
  collectionAddress: string,
  tokenId: string,
  chainId: string = '8453',
): Promise<{ address: string; username: string | null } | null> {
  try {
    const url = inprocessUrl('/timeline', {
      collection: collectionAddress,
      limit: 50,
      chain_id: chainId,
    })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      moments?: Array<{
        token_id?: string
        creator?: { address?: string; username?: string | null }
      }>
    }
    const row = data.moments?.find((m) => m.token_id === tokenId)
    if (!row?.creator?.address) return null
    return {
      address: row.creator.address,
      username: row.creator.username ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Server-side moment detail fetch shared by the canonical page and the
 * intercepting-route overlay. Wrapped in React.cache so co-running
 * server components (e.g. canonical page's generateMetadata + render)
 * dedupe to a single upstream call per request.
 *
 * The 60s revalidate is the same window the /api/moment proxy uses, so
 * client and server reads stay consistent on first paint. Hidden state
 * is read uncached from KV alongside the fetch and merged in — same
 * shape /api/moment returns. Creator prefers the KV minter EOA (the real
 * artist) over inprocess's timeline attribution, with the artist's username
 * resolved server-side so page metadata + the OG share card read the real
 * name (no momentAdmins[0] guessing, no operator mis-attribution).
 */
export const fetchMomentDetail = cache(async (
  address: string,
  tokenId: string,
): Promise<MomentDetail | null> => {
  try {
    const url = inprocessUrl('/moment', { collectionAddress: address, tokenId, chainId: '8453' })
    const [res, hidden, timelineCreator, kvCreator] = await Promise.all([
      fetch(url, { next: { revalidate: 60 }, signal: AbortSignal.timeout(8_000) }),
      isMomentHidden(address, tokenId),
      fetchCreatorFromTimeline(address, tokenId),
      getKvCreatorAddress(address, tokenId),
    ])
    if (!res.ok) return null
    const data = (await res.json()) as MomentDetail
    // Fill the price from chain when the feed omits saleConfig (writing moments /
    // fresh mints during an indexer gap) so the SSR'd detail badge isn't blank on
    // first paint — same authoritative source the collect action + /api/moment(s)
    // read.
    if (!data.saleConfig) {
      const sale = await onchainSaleConfigFallback(
        serverBaseClient(),
        address as Address,
        BigInt(tokenId),
      )
      if (sale) data.saleConfig = sale
    }
    // Prefer the KV minter EOA (the real artist) over inprocess's timeline
    // attribution (the collection operator for delegated mints) — same priority
    // as /api/moment and the detail page. Unlike /api/moment (which leaves the
    // name for the client to resolve), resolve the artist's username server-side
    // here: the consumers are the page metadata + OG share card, which have no
    // client to do it. resolveCanonicalProfile covers every identity model
    // (address-keyed, FID-keyed, sibling-inherited) + the FC-username fallback,
    // matching the profile page. Non-Kismet mints (no KV entry) keep the
    // timeline creator.
    let creator = timelineCreator
    if (kvCreator) {
      const { profile, farcaster } = await resolveCanonicalProfile(kvCreator)
      creator = { address: kvCreator, username: profile.username || farcaster?.username || null }
    }
    return { ...data, hidden, creator }
  } catch {
    return null
  }
})

/**
 * EOA recorded by mint-proxy at mint time. Inprocess /moment returns the
 * platform smart wallet as creator.address for Kismet-minted moments, and
 * Kismet profiles are keyed by EOA — without this fallthrough the creator
 * chip would stay stuck on a shortAddress.
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
