import { NextRequest, NextResponse, after } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getStoredSplits, selfHealRecipientIndex } from '@/lib/splits'
import { errorResponse } from '@/lib/apiResponse'

// Returns { hasSplits, recipients } for a single moment. `hasSplits` gates the
// distribute UI; `recipients` lets it detect whether the viewer is a payee.
// Empty recipients = legacy `'1'`-flag mints (distribute still works via
// creator/admin; no splits panel).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')

  if (!collectionAddress || !tokenId) {
    return errorResponse(400, 'collectionAddress and tokenId required')
  }
  if (!isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }

  const stored = await getStoredSplits(collectionAddress, tokenId).catch(() => ({
    hasSplits: false,
    recipients: [],
  }))
  // Self-heal the recipient→moments reverse index for moments minted before it
  // existed (or whose mint-time write failed). A permanent NX marker makes this
  // heal-once per moment, off the response path — not a write on every view.
  if (stored.recipients.length) {
    after(() => selfHealRecipientIndex(collectionAddress, tokenId, stored.recipients))
  }
  return NextResponse.json(stored)
}
