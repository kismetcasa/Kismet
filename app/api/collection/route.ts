import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'

/**
 * Proxy to inprocess `GET /api/collection` (singular). Returns a single
 * collection's enriched metadata: default_admin (with username),
 * payout_recipient, timestamps, full resolved metadata. Used by the
 * collection page header to render @username + payout transparency
 * chips. The plural `/api/collections` only returns lightweight rows;
 * the detail page wants the rich shape from this endpoint.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress') ?? searchParams.get('address')
  const chainId = searchParams.get('chainId') ?? '8453'

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }

  const url = new URL(`${INPROCESS_API}/collection`)
  url.searchParams.set('collectionAddress', collectionAddress)
  url.searchParams.set('chainId', chainId)

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
      // Indexer hasn't picked up the collection yet — return null cleanly so
      // the page can fall back to the lightweight /api/collections row + KV.
      return NextResponse.json(null, { status: 200 })
    }
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 })
  }
}
