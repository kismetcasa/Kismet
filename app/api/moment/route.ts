import { NextRequest, NextResponse, after } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl, normalizeMomentDetail } from '@/lib/inprocess'
import { recordSaleEnds } from '@/lib/saleEnds'
import { bestEffort } from '@/lib/bestEffort'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { isProfileIdentityHidden } from '@/lib/addressUnion'
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
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: 502 })
  }
  // A non-2xx keeps its status (404 = no such token). Its body is an error
  // envelope, not a moment, so there's nothing to normalize or to price.
  if (!upstream.ok) {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: upstream.status })
  }
  // The wire body → Kismet's MomentDetail (lib/inprocess) — the only shape
  // this route serves, whichever generation of field names upstream sent.
  const detail = normalizeMomentDetail(raw)
  if (!detail) {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: 502 })
  }
  // Fill the price from chain when the feed has no usable sale (writing
  // moments / fresh mints during an indexer gap) — the same authoritative
  // source the collect action reads (and /api/moments), so the detail badge
  // isn't blank while the sale is live. With a sale, the feed's mirror is
  // served as-is: it trails a sale edit by a minute or two (the editor updates
  // its own view from the receipt) and matched chain on every sampled field.
  if (!detail.saleConfig) {
    const sale = await onchainSaleConfigFallback(
      serverBaseClient(),
      collectionAddress as Address,
      BigInt(tokenId),
    )
    if (sale) detail.saleConfig = sale
  }
  // Inject the hidden flag so the client can render a creator-only
  // hidden-state UI without an extra round-trip. Inject `creator` because
  // the /moment body has no per-token creator (its admin list and owner are
  // collection-level).
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
  let creator = kvCreator
    ? { address: kvCreator, username: null }
    : timelineCreator
  // Hidden-identity strip: a hidden profile's username must not leak on the
  // detail-view refetch/poll path. The KV branch already nulls it; this
  // covers the non-Kismet-mint branch that carries the inprocess username.
  // Sibling-aware via the memoized identity closure.
  if (creator?.username && creator.address && (await isProfileIdentityHidden(creator.address))) {
    creator = { ...creator, username: null }
  }

  // Same sale-index write-through as /api/moments (ending-soon + free-mint),
  // for the detail-view price path — widens coverage to moments reached by
  // direct link (shared URLs, notifications) that may never render in a feed
  // batch. Only on a successfully priced response: an upstream error returned
  // above never reaches this line, and a null config (no sale from the feed
  // or the chain, e.g. an RPC blip) is skipped, so a blip can't erase a live
  // entry.
  const saleConfig = detail.saleConfig ?? null
  after(() =>
    recordSaleEnds([
      {
        key: `${collectionAddress.toLowerCase()}:${BigInt(tokenId).toString()}`,
        config: saleConfig,
      },
    ]).catch(bestEffort('moment.recordSaleEnds')),
  )

  return NextResponse.json({ ...detail, hidden, creator }, { status: upstream.status })
}
