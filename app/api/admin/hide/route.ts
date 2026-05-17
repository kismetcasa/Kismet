import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { verifyAdminSession } from '@/lib/curator'
import { hideCollection, unhideCollection } from '@/lib/hiddenCollections'
import { hideMoment, unhideMoment } from '@/lib/hiddenMoments'
import { errorResponse } from '@/lib/apiResponse'

interface HideBody {
  type?: 'moment' | 'collection'
  address?: string
  tokenId?: string
  hidden?: boolean
}

/**
 * Admin-gated visibility toggle for any moment or collection. The user-
 * facing /api/moment/hide and /api/collection/hide gate on creator /
 * on-chain admin respectively; this route bypasses both for platform
 * moderation. Writes to the same Redis sets (hiddenMoments / hiddenCollections),
 * so feed filtering picks up the change immediately with no extra wiring.
 * Auth via HttpOnly session cookie set by /api/auth/login.
 */
export async function POST(req: NextRequest) {
  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as HideBody | null
  if (!body) return errorResponse(400, 'Invalid body')

  const { type, address, tokenId, hidden } = body
  if (type !== 'moment' && type !== 'collection') {
    return errorResponse(400, 'type must be "moment" or "collection"')
  }
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  if (typeof hidden !== 'boolean') {
    return errorResponse(400, 'hidden must be a boolean')
  }

  if (type === 'moment') {
    if (!isValidTokenId(tokenId)) {
      return errorResponse(400, 'Invalid tokenId')
    }
    if (hidden) await hideMoment(address, tokenId)
    else await unhideMoment(address, tokenId)
  } else {
    if (hidden) await hideCollection(address)
    else await unhideCollection(address)
  }

  return NextResponse.json({ ok: true, hidden })
}
