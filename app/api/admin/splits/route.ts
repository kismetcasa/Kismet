import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { setStoredSplits, validateSplitsArray } from '@/lib/splits'

interface BackfillBody {
  signature?: string
  timestamp?: number
  collectionAddress?: string
  tokenId?: string
  recipients?: unknown
}

// Curator escape-hatch for legacy moments whose splits predate
// recipient persistence in lib/mint-proxy.ts. New mints record
// recipients automatically; this route only repairs old ones.
// Allocations may carry sub-percent precision since admins import
// from off-chain records (Math.round absorbs the drift).
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as BackfillBody | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const authErr = await verifyAdminSession(body)
  if (authErr) return NextResponse.json({ error: authErr.error }, { status: authErr.status })

  const { collectionAddress, tokenId } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!isValidTokenId(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }

  const result = validateSplitsArray(body.recipients, { requireIntegerPercents: false })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  await setStoredSplits(collectionAddress, tokenId, result.splits)
  return NextResponse.json({ ok: true, recipients: result.splits })
}
