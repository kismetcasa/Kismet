import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { redis } from '@/lib/redis'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')

  if (!collectionAddress || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId required' }, { status: 400 })
  }
  if (!isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!isValidTokenId(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }

  const key = `kismetart:splits:${collectionAddress.toLowerCase()}:${tokenId}`
  const exists = await redis.exists(key).catch(() => 0)
  return NextResponse.json({ hasSplits: exists === 1 })
}
