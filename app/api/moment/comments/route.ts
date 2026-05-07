import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  const chainId = searchParams.get('chainId') ?? '8453'
  const offset = searchParams.get('offset') ?? '0'

  if (!collectionAddress || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId required' }, { status: 400 })
  }
  if (!isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!isValidTokenId(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (!/^\d+$/.test(offset)) {
    return NextResponse.json({ error: 'Invalid offset' }, { status: 400 })
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
    return NextResponse.json({ error: 'upstream error' }, { status: 502 })
  }
  return NextResponse.json(data, { status: res.status })
}
