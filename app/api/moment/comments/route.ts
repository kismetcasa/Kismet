import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { errorResponse } from '@/lib/apiResponse'

interface Comment {
  sender?: string
  // inprocess response carries other fields (comment text, timestamp,
  // etc.) — we pass them through opaquely; only `sender` matters for
  // the hidden-users filter.
  [k: string]: unknown
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const collectionAddress = searchParams.get('collectionAddress')
  const tokenId = searchParams.get('tokenId')
  const chainId = searchParams.get('chainId') ?? '8453'
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

  const url = inprocessUrl('/moment/comments', {
    collectionAddress,
    tokenId,
    chainId,
    offset: offset !== '0' ? offset : undefined,
  })

  // Fetch upstream and the hidden-users set in parallel — both are cheap
  // (inprocess revalidate=30, hidden-users memoized 60s) and independent.
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

  // Strip comments authored by admin-hidden users. Comments are content
  // attributable to the commenter — even on a visible moment, a hidden
  // user's commentary shouldn't surface to other viewers. Symmetric with
  // how /api/timeline and /api/listings drop content authored by hidden
  // users. No own-profile exception: comments live in a public per-
  // moment thread, not on the commenter's own profile, so the "user
  // sees their own content" carve-out doesn't apply at this surface.
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
