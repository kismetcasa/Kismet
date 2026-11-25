import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { stripHiddenDeployerIdentity } from '@/lib/hiddenDeployer'
import { readCollectionRoles } from '@/lib/collectionRoles'
import {
  COLLECTION_DETAIL_CHAIN_ID,
  fetchInprocessCollection,
  isKnownIndexed,
} from '@/lib/inprocessCollection'
import { getCollectionMeta } from '@/lib/kv'

/**
 * A single collection's enriched record, from In Process's collection detail
 * (lib/inprocessCollection — the CAIP `GET /collections/{network}/{contract}`
 * route; the singular `/collection` route this used to proxy was removed
 * upstream, 404ing since at least 2026-06-29). Shape: creator + default_admin (with username),
 * payout_recipient (read on-chain from the contract's fundsRecipient — In
 * Process no longer returns it), timestamps, full resolved metadata.
 *
 * `null` (HTTP 200) when In Process has no record for the collection (indexer
 * lag on a fresh deploy) so a caller can fall back to its own data; 502 when
 * In Process is unreachable or erroring.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress') ?? searchParams.get('address')
  const chainIdParam = searchParams.get('chainId') ?? String(COLLECTION_DETAIL_CHAIN_ID)

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  const chainId = Number(chainIdParam)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return errorResponse(400, 'Invalid chainId')
  }

  const result = await fetchInprocessCollection(collectionAddress, {
    caller: 'api/collection',
    chainId,
    revalidate: 60,
    expectIndexed: () => getCollectionMeta(collectionAddress).then(isKnownIndexed),
  })
  if (!result.detail) {
    if (result.miss.kind === 'network' || result.miss.kind === 'upstream_error') {
      return errorResponse(502, 'upstream unavailable')
    }
    return NextResponse.json(null, { status: 200 })
  }

  // Only for a collection In Process knows: bounds this public route's RPC
  // reads to real collections (the roles cache absorbs repeats).
  const roles =
    chainId === COLLECTION_DETAIL_CHAIN_ID ? await readCollectionRoles(collectionAddress) : null
  const payout_recipient = roles?.fundsRecipient ?? result.detail.payout_recipient
  // Null a hidden-identity deployer's @handle (creator / default_admin) so
  // the collection header can't surface it. Address is preserved.
  return NextResponse.json(
    await stripHiddenDeployerIdentity({
      ...result.detail,
      ...(payout_recipient ? { payout_recipient } : {}),
    }),
  )
}
