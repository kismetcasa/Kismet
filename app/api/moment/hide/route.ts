import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { getMomentMeta } from '@/lib/notifications'
import { hideMoment, unhideMoment, isMomentHidden } from '@/lib/hiddenMoments'
import { INPROCESS_API } from '@/lib/inprocess'
import { errorResponse } from '@/lib/apiResponse'

interface HideBody {
  collectionAddress?: string
  tokenId?: string
  hidden?: boolean
}

// POST /api/moment/hide — toggle a moment's visibility. Auth required;
// caller must be the moment's creator (verified via the moment-meta KV
// entry that mint-proxy writes on every successful mint).
export async function POST(req: NextRequest) {
  const viewer = await getSessionAddress(req)
  if (!viewer) {
    return errorResponse(401, 'Sign in to continue')
  }

  let body: HideBody
  try {
    body = (await req.json()) as HideBody
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { collectionAddress, tokenId, hidden } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  if (typeof hidden !== 'boolean') {
    return errorResponse(400, 'hidden must be a boolean')
  }

  // Authorize against the local moment-meta record first (fast path —
  // mint-proxy writes { creator, name } on every successful Kismet mint).
  // Fall back to the inprocess timeline endpoint for older mints (pre
  // moment-meta KV) or moments minted outside Kismet. We read `creator`
  // from the timeline shape — NOT momentAdmins[0] — because inprocess's
  // /moment exposes momentAdmins as an unordered list (platform smart
  // wallets, factory grants, the actual minter), and position [0] is
  // often a platform admin rather than the creator. /timeline has a
  // dedicated creator field for exactly this lookup.
  const meta = await getMomentMeta(collectionAddress, tokenId)
  let creatorLower = meta?.creator?.toLowerCase()

  if (!creatorLower) {
    try {
      const url = new URL(`${INPROCESS_API}/timeline`)
      url.searchParams.set('collection', collectionAddress)
      url.searchParams.set('limit', '50')
      url.searchParams.set('chain_id', '8453')
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 60 },
      })
      if (res.ok) {
        const data = (await res.json()) as {
          moments?: Array<{
            token_id?: string
            creator?: { address?: string }
          }>
        }
        const row = data.moments?.find((m) => m.token_id === tokenId)
        const candidate = row?.creator?.address
        if (typeof candidate === 'string') {
          creatorLower = candidate.toLowerCase()
        }
      }
    } catch {
      // Network or JSON failure — fall through to the 403 below.
    }
  }

  if (!creatorLower) {
    return errorResponse(403, 'Cannot verify creator for this moment')
  }
  if (creatorLower !== viewer.toLowerCase()) {
    return errorResponse(403, 'Only the creator can hide this moment')
  }

  if (hidden) {
    await hideMoment(collectionAddress, tokenId)
  } else {
    await unhideMoment(collectionAddress, tokenId)
  }

  return NextResponse.json({ hidden })
}

// GET /api/moment/hide?collectionAddress=…&tokenId=… — returns current
// hidden state. Public read; UIs use it to seed the toggle's initial state.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  if (!collectionAddress || !isAddress(collectionAddress) || !isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid query params')
  }
  const hidden = await isMomentHidden(collectionAddress, tokenId)
  return NextResponse.json({ hidden })
}
