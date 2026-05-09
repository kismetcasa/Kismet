import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getStoredSplits } from '@/lib/splits'

// Returns { hasSplits, recipients } for a single moment.
// `hasSplits` gates the creator-only distribute UI in useMomentSplits.
// `recipients` is empty for legacy mints stored as the `'1'` flag —
// those continue to support distribute but render no splits panel.
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

  const stored = await getStoredSplits(collectionAddress, tokenId).catch(() => ({
    hasSplits: false,
    recipients: [],
  }))
  return NextResponse.json(stored)
}
