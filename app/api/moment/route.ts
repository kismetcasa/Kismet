import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { fetchCreatorFromTimeline, getKvCreatorAddress } from '@/lib/momentDetail'
import { onchainSaleConfigFallback } from '@/lib/saleConfig'
import { serverBaseClient } from '@/lib/rpc'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  const chainId = searchParams.get('chainId') ?? '8453'

  if (!collectionAddress || !tokenId) {
    return errorResponse(400, 'collectionAddress and tokenId are required')
  }
  if (!isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }

  const url = inprocessUrl('/moment', { collectionAddress, tokenId, chainId })

  // The whole gather is try/caught so an upstream timeout (the 8s signal) or
  // network failure degrades to the route's 502 shape instead of an unhandled
  // rejection → generic 500. The non-fetch legs already degrade internally;
  // without the upstream body there is nothing to serve either way.
  let upstream: Response
  let momentHidden: boolean
  let collectionHidden: boolean
  let timelineCreator: Awaited<ReturnType<typeof fetchCreatorFromTimeline>>
  let kvCreator: Awaited<ReturnType<typeof getKvCreatorAddress>>
  try {
    ;[upstream, momentHidden, collectionHidden, timelineCreator, kvCreator] = await Promise.all([
      fetch(url, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 60 },
        signal: AbortSignal.timeout(8_000),
      }),
      isMomentHidden(collectionAddress, tokenId),
      isCollectionHidden(collectionAddress),
      fetchCreatorFromTimeline(collectionAddress, tokenId, chainId),
      getKvCreatorAddress(collectionAddress, tokenId),
    ])
  } catch {
    return errorResponse(502, 'upstream unreachable')
  }
  const text = await upstream.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: 502 })
  }
  // Fill the price from chain when the feed omits saleConfig (writing moments /
  // fresh mints during an indexer gap) — the same authoritative source the
  // collect action reads (and /api/moments), so the detail badge isn't blank
  // while the sale is live.
  if (!data.saleConfig) {
    const sale = await onchainSaleConfigFallback(
      serverBaseClient(),
      collectionAddress as Address,
      BigInt(tokenId),
    )
    if (sale) data.saleConfig = sale
  }
  // Inject the hidden flag so the client can render a creator-only
  // hidden-state UI without an extra round-trip. Inject `creator` from
  // the timeline lookup so detail page can stop reading momentAdmins[0].
  //
  // Cascade: a moment in a hidden collection is treated the same as an
  // individually-hidden moment. The existing MomentDetailView gate
  // (`isHidden && !isCreator`) then keeps non-creators on the placeholder.
  // The collection admin's unhide affordance lives on the collection page,
  // not here — they navigate there to flip the master toggle.
  const hidden = momentHidden || collectionHidden
  // Prefer the KV creator (the real minter EOA the mint-proxy wrote at mint
  // time) over inprocess's timeline attribution, which credits the collection's
  // operator/defaultAdmin for delegated mints. Username is left null so the
  // client resolves it from the corrected address. Mirrors the moment detail
  // page's creator priority.
  const creator = kvCreator
    ? { address: kvCreator, username: null }
    : timelineCreator
  return NextResponse.json({ ...data, hidden, creator }, { status: upstream.status })
}
