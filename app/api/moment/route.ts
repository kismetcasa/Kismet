import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { isCollectionHidden } from '@/lib/hiddenCollections'
import { fetchCreatorFromTimeline } from '@/lib/momentDetail'
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

  const [upstream, momentHidden, collectionHidden, creator] = await Promise.all([
    fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    }),
    isMomentHidden(collectionAddress, tokenId),
    isCollectionHidden(collectionAddress),
    fetchCreatorFromTimeline(collectionAddress, tokenId, chainId),
  ])
  const text = await upstream.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: 502 })
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
  return NextResponse.json({ ...data, hidden, creator }, { status: upstream.status })
}
