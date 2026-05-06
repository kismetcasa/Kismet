import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { isMomentHidden } from '@/lib/hiddenMoments'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  const chainId = searchParams.get('chainId') ?? '8453'

  if (!collectionAddress || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId are required' }, { status: 400 })
  }
  if (!isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }

  const url = new URL(`${INPROCESS_API}/moment`)
  url.searchParams.set('collectionAddress', collectionAddress)
  url.searchParams.set('tokenId', tokenId)
  url.searchParams.set('chainId', chainId)

  const [upstream, hidden] = await Promise.all([
    fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    }),
    isMomentHidden(collectionAddress, tokenId),
  ])
  const text = await upstream.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: 502 })
  }
  // Inject the hidden flag so the client can render a creator-only
  // hidden-state UI without an extra round-trip.
  return NextResponse.json({ ...data, hidden }, { status: upstream.status })
}
