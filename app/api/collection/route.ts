import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { getCollectionChainId } from '@/lib/kv'
import { errorResponse } from '@/lib/apiResponse'

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

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }

  const chainId = searchParams.get('chainId') ?? String(await getCollectionChainId(collectionAddress))

  const url = inprocessUrl('/collection', { collectionAddress, chainId })

  try {
    const res = await fetch(url, {
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
    return errorResponse(502, 'upstream unreachable')
  }
}
