import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { AIRDROP_INVITE_COMMENT, inprocessUrl, normalizeTimestampMs, type MomentComment } from '@/lib/inprocess'
import { getAirdropsByMoment } from '@/lib/airdrops'
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

  // Kismet airdrops (adminMints) never leave a collect comment on the
  // inprocess feed, so without this fold the recipients are invisible — the
  // supply count includes them but the activity list doesn't. Merge them in
  // as "invited to kismet" rows on the FIRST page only (the UI fetches offset
  // 0 and scrolls); paginating gifts alongside comments isn't worth it.
  const isFirstPage = offset === '0'

  // try/caught so an upstream timeout (the 8s signal) or network failure
  // degrades to the route's 502 shape instead of an unhandled rejection.
  let res: Response
  let hiddenUsers: Set<string>
  let airdrops: Awaited<ReturnType<typeof getAirdropsByMoment>>
  try {
    ;[res, hiddenUsers, airdrops] = await Promise.all([
      fetch(url, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 30 },
        signal: AbortSignal.timeout(8_000),
      }),
      getHiddenUsersSet(),
      // getAirdropsByMoment swallows its own errors (returns []), so this
      // can't reject the Promise.all and mask a real upstream failure.
      isFirstPage ? getAirdropsByMoment(collectionAddress, tokenId) : Promise.resolve([]),
    ])
  } catch {
    return errorResponse(502, 'upstream unreachable')
  }

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

  // Fold airdrop "invited to kismet" rows into the first page and re-sort the
  // whole page newest-first so gifts land in the right temporal spot next to
  // collects. Only touch a well-formed 2xx body; an upstream error passes
  // through untouched (so its status/shape is preserved for the client).
  if (isFirstPage && airdrops.length > 0 && res.ok && data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    const existing = Array.isArray(obj.comments) ? (obj.comments as MomentComment[]) : []
    const airdropRows: MomentComment[] = airdrops
      // The recipient is the shown party here, so mirror the comment filter
      // and drop rows whose recipient is an admin-hidden user.
      .filter((a) => !hiddenUsers.has(a.recipient.address.toLowerCase()))
      .map((a) => ({
        sender: a.recipient.address,
        comment: AIRDROP_INVITE_COMMENT,
        timestamp: a.timestamp,
        kind: 'airdrop' as const,
      }))
    if (airdropRows.length > 0) {
      // `|| 0` guards a missing/NaN upstream timestamp from scrambling the
      // sort (NaN comparisons are undefined) — such a row just sinks to the
      // bottom instead of randomizing the whole page.
      obj.comments = [...existing, ...airdropRows].sort(
        (x, y) => (normalizeTimestampMs(y.timestamp) || 0) - (normalizeTimestampMs(x.timestamp) || 0),
      )
    }
  }

  return NextResponse.json(data, { status: res.status })
}
