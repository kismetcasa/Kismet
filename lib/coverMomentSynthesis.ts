import { inprocessUrl, type Moment, type MomentDetail } from './inprocess'
import { BASE_CHAIN_ID } from './chains'
import { getCollectionMeta } from './kv'
import { getMomentMeta } from './notifications'

/**
 * Cover-mints created via the factory setupAction path (the "create
 * collection + mint cover" deploy flow) don't enter inprocess's /timeline
 * indexer. The deploy transaction is chain-direct — frontend writes
 * factory.createContract(..., setupActions) — with no server-to-server
 * call to inprocess's /moment/create that backs the regular MintForm
 * path. /moment/<addr>/<tokenId> still resolves because inprocess reads
 * chain on demand for that endpoint, but every by-collection fan-out
 * surface (collection page, artists tab, mints feed, profile, discover)
 * is blind to cover-mints.
 *
 * This helper patches the gap: when the per-collection /timeline response
 * doesn't include the cover token, fetch /moment + /collection + KV
 * moment-meta in parallel and build a properly-shaped Moment to merge in.
 *
 * Gated by `coverTokenId` on collection-meta KV, which /api/collections
 * POST writes only when source === 'create-form' AND a cover was minted.
 * That keeps the synthesis scoped to case #2 — collection-with-cover-at-
 * deploy — and never fires for case #1 (collection only, no cover) or
 * case #3 (individual MintForm mint, which inprocess indexes normally).
 *
 * Returns the moment to merge into the existing list, or null when there's
 * nothing to add: no coverTokenId, cover already in the list, /moment
 * fetch failed, or attribution couldn't be resolved cleanly. Synthesis
 * never throws — any error short-circuits to null so callers can keep
 * serving whatever inprocess did return.
 */
export async function synthesizeMissingCoverMoment(
  collectionAddress: string,
  existingMoments: { token_id?: string | number }[],
  chainId: number = BASE_CHAIN_ID,
): Promise<Moment | null> {
  const collMeta = await getCollectionMeta(collectionAddress).catch(() => null)
  const coverTokenId = collMeta?.coverTokenId
  if (!coverTokenId) return null
  if (existingMoments.some((m) => String(m.token_id) === coverTokenId)) return null

  const [detail, collInfo, momentMeta] = await Promise.all([
    fetchMomentDetail(collectionAddress, coverTokenId, chainId),
    fetchCollectionCreatedAt(collectionAddress, chainId),
    getMomentMeta(collectionAddress, coverTokenId).catch(() => null),
  ])

  if (!detail) return null

  // Prefer KV moment-meta (written at deploy time by /api/collections POST
  // for new cover-mints, or by the one-off backfill for pre-feature
  // deploys). Fall back to the collection's `artist` field — the deployer
  // EOA, same address that would have been written to moment-meta. Bail
  // if neither is available rather than render a moment under the wrong
  // attribution.
  const creatorAddress = (momentMeta?.creator ?? collMeta.artist)?.toLowerCase()
  if (!creatorAddress) return null

  return {
    address: collectionAddress.toLowerCase(),
    token_id: coverTokenId,
    chain_id: chainId,
    uri: detail.uri,
    creator: { address: creatorAddress, hidden: false },
    admins: detail.momentAdmins.map((a) => ({ address: a.toLowerCase(), hidden: false })),
    // The cover-mint shares its block with the collection deploy. Use the
    // collection's created_at as the moment's created_at so newest-first
    // sorts place it correctly (epoch 0 fallback parks the moment at the
    // bottom if inprocess /collection is unreachable, which is a safer
    // failure mode than pinning to "now" and jumping to the top).
    created_at: collInfo?.created_at ?? new Date(0).toISOString(),
    metadata: detail.metadata,
  }
}

async function fetchMomentDetail(
  address: string,
  tokenId: string,
  chainId: number,
): Promise<MomentDetail | null> {
  try {
    const url = inprocessUrl('/moment', {
      collectionAddress: address,
      tokenId,
      chainId,
    })
    const res = await fetch(url, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const text = await res.text()
    return text ? (JSON.parse(text) as MomentDetail) : null
  } catch {
    return null
  }
}

async function fetchCollectionCreatedAt(
  address: string,
  chainId: number,
): Promise<{ created_at?: string } | null> {
  try {
    const url = inprocessUrl('/collection', {
      collectionAddress: address,
      chainId,
    })
    const res = await fetch(url, { next: { revalidate: 60 } })
    if (!res.ok) return null
    const text = await res.text()
    return text ? (JSON.parse(text) as { created_at?: string }) : null
  } catch {
    return null
  }
}
