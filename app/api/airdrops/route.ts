import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'

/**
 * Proxy to inprocess `GET /api/airdrops` — lists historical airdrops sent
 * by the given artist. Used by ProfileView's airdrops tab so creators can
 * audit who they've airdropped and when. Public read; rate-limited.
 *
 * Inprocess response shape (per docs):
 *   [{ collectionAddress, tokenId, recipient: { address, username }, amount }]
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist_address') ?? searchParams.get('artist')
  const offsetParam = searchParams.get('offset')
  const chainIdParam = searchParams.get('chainId')

  if (!artist || !isAddress(artist)) {
    return NextResponse.json({ error: 'Invalid artist_address' }, { status: 400 })
  }

  const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0
  const chainId = chainIdParam ?? '8453'

  const url = new URL(`${INPROCESS_API}/airdrops`)
  url.searchParams.set('artist_address', artist)
  url.searchParams.set('chainId', chainId)
  url.searchParams.set('offset', String(offset))

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    const text = await res.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      // Inprocess returns non-JSON when an artist has no airdrops yet —
      // mirror /api/payments and degrade to an empty list rather than 502
      // the whole panel.
      return NextResponse.json({ airdrops: [] }, { status: 200 })
    }
    // Their endpoint returns a bare array per docs; normalize to
    // { airdrops: [...] } so the client doesn't have to special-case shape.
    const airdrops = Array.isArray(data) ? data : []
    return NextResponse.json({ airdrops }, { status: res.status })
  } catch {
    return NextResponse.json({ airdrops: [] }, { status: 200 })
  }
}
