import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { getCollectionChainId } from '@/lib/kv'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { errorResponse } from '@/lib/apiResponse'

// Only `sender` matters for the hidden-users filter; other fields
// (comment text, timestamp, etc.) pass through opaquely.
interface Comment {
  sender?: string
  [k: string]: unknown
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
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

  // Client may pass the moment's chain explicitly; otherwise resolve by address.
  const chainId = searchParams.get('chainId') ?? String(await getCollectionChainId(collectionAddress))

  const url = inprocessUrl('/moment/comments', {
    collectionAddress,
    tokenId,
    chainId,
    offset: offset !== '0' ? offset : undefined,
  })

  const [res, hiddenUsers] = await Promise.all([
    fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 30 },
    }),
    getHiddenUsersSet(),
  ])

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return errorResponse(502, 'upstream error')
  }

  // No own-profile exception here: comments live in a public per-moment
  // thread, not on the commenter's own profile, so the "user sees their
  // own content" carve-out used in timeline / airdrops / payments
  // doesn't apply.
  if (hiddenUsers.size > 0 && data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.comments)) {
      obj.comments = (obj.comments as Comment[]).filter((c) => {
        const sender = typeof c.sender === 'string' ? c.sender.toLowerCase() : ''
        return !hiddenUsers.has(sender)
      })
    }
  }

  return NextResponse.json(data, { status: res.status })
}
