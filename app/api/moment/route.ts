import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { isMomentHidden } from '@/lib/hiddenMoments'

// Inprocess `/api/moment` returns `MomentDetail` whose `momentAdmins` field
// is an unordered list (platform admins, smart wallets, the actual creator)
// — position [0] is NOT reliably the minter. The timeline endpoint, in
// contrast, has a dedicated `creator` field. Look up the same token via
// timeline in parallel so we can stitch a real `creator` onto the moment
// response and stop guessing momentAdmins[0] downstream.
async function fetchCreator(
  collectionAddress: string,
  tokenId: string,
  chainId: string,
): Promise<{ address: string; username: string | null } | null> {
  try {
    const url = new URL(`${INPROCESS_API}/timeline`)
    url.searchParams.set('collection', collectionAddress)
    // We only need the row for this tokenId; cap small to keep upstream cheap.
    url.searchParams.set('limit', '50')
    url.searchParams.set('chain_id', chainId)
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      moments?: Array<{
        token_id?: string
        creator?: { address?: string; username?: string | null }
      }>
    }
    const row = data.moments?.find((m) => m.token_id === tokenId)
    if (!row?.creator?.address) return null
    return {
      address: row.creator.address,
      username: row.creator.username ?? null,
    }
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  const chainId = searchParams.get('chainId') ?? '8453'

  if (!collectionAddress || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId are required' }, { status: 400 })
  }
  if (!isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!isValidTokenId(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }

  const url = new URL(`${INPROCESS_API}/moment`)
  url.searchParams.set('collectionAddress', collectionAddress)
  url.searchParams.set('tokenId', tokenId)
  url.searchParams.set('chainId', chainId)

  const [upstream, hidden, creator] = await Promise.all([
    fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    }),
    isMomentHidden(collectionAddress, tokenId),
    fetchCreator(collectionAddress, tokenId, chainId),
  ])
  const text = await upstream.text()
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'upstream error', status: upstream.status }, { status: 502 })
  }
  // Inject the hidden flag so the client can render a creator-only
  // hidden-state UI without an extra round-trip. Inject `creator` from
  // the timeline lookup so detail page can stop reading momentAdmins[0].
  return NextResponse.json({ ...data, hidden, creator }, { status: upstream.status })
}
