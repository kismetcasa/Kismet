import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getSessionAddress } from '@/lib/session'
import { getMomentMeta } from '@/lib/notifications'
import { hideMoment, unhideMoment, isMomentHidden } from '@/lib/hiddenMoments'
import { INPROCESS_API } from '@/lib/inprocess'

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
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  let body: HideBody
  try {
    body = (await req.json()) as HideBody
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { collectionAddress, tokenId, hidden } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (typeof hidden !== 'boolean') {
    return NextResponse.json({ error: 'hidden must be a boolean' }, { status: 400 })
  }

  // Authorize against the local moment-meta record first (fast path —
  // mint-proxy writes { creator, name } on every successful Kismet mint).
  // Fall back to inprocess /api/moment for older mints (pre moment-meta KV)
  // or moments minted outside Kismet — momentAdmins[0] is the creator.
  const meta = await getMomentMeta(collectionAddress, tokenId)
  let creatorLower = meta?.creator?.toLowerCase()

  if (!creatorLower) {
    try {
      const url = new URL(`${INPROCESS_API}/moment`)
      url.searchParams.set('collectionAddress', collectionAddress)
      url.searchParams.set('tokenId', tokenId)
      url.searchParams.set('chainId', '8453')
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 60 },
      })
      if (res.ok) {
        const data = (await res.json()) as { momentAdmins?: string[] }
        const firstAdmin = Array.isArray(data?.momentAdmins) ? data.momentAdmins[0] : undefined
        if (firstAdmin && typeof firstAdmin === 'string') {
          creatorLower = firstAdmin.toLowerCase()
        }
      }
    } catch {
      // Network or JSON failure — fall through to the 403 below.
    }
  }

  if (!creatorLower) {
    return NextResponse.json(
      { error: 'Cannot verify creator for this moment' },
      { status: 403 },
    )
  }
  if (creatorLower !== viewer.toLowerCase()) {
    return NextResponse.json({ error: 'Only the creator can hide this moment' }, { status: 403 })
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
  if (!collectionAddress || !isAddress(collectionAddress) || !tokenId || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'Invalid query params' }, { status: 400 })
  }
  const hidden = await isMomentHidden(collectionAddress, tokenId)
  return NextResponse.json({ hidden })
}
