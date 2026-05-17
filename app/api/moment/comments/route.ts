import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  const chainId = searchParams.get('chainId') ?? '8453'
  const offset = searchParams.get('offset') ?? '0'

  if (!collectionAddress || !tokenId) {
    return errorResponse(400, 'collectionAddress and tokenId required')
  }
  if (!isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  if (!/^\d+$/.test(offset)) {
    return errorResponse(400, 'Invalid offset')
  }

  const url = new URL(`${INPROCESS_API}/moment/comments`)
  url.searchParams.set('collectionAddress', collectionAddress)
  url.searchParams.set('tokenId', tokenId)
  url.searchParams.set('chainId', chainId)
  if (offset !== '0') url.searchParams.set('offset', offset)

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
    next: { revalidate: 30 },
  })

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return errorResponse(502, 'upstream error')
  }
  return NextResponse.json(data, { status: res.status })
}
