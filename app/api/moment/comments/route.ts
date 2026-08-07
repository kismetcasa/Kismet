import { NextRequest, NextResponse } from 'next/server'
import { isAddress, isValidTokenId } from '@/lib/address'
import { AIRDROP_INVITE_COMMENT, AIRDROP_GENERIC_COMMENT, INPROCESS_COMMENTS_PAGE_SIZE, inprocessUrl, normalizeTimestampMs, type MomentComment } from '@/lib/inprocess'
import { getAirdropsByMoment } from '@/lib/airdrops'
import { isPatronCollection } from '@/lib/patronCollection'
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

  // In Process's 2026-07 comments-contract migration removed /moment/comments
  // (it now returns their deployment's 404 page) and serves GET /comments —
  // same query params and {comments:[…]} envelope. Rows carry the same
  // sender/comment/timestamp(ms) fields the client renders, plus new
  // username/commentId/replyToId/nonce/replyCount/replies fields that pass
  // through this proxy opaquely. Mint-time collect comments ride along with
  // commentId:null, so the who-collected rows keep flowing from one source.
  const url = inprocessUrl('/comments', {
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

  // Whether another upstream page exists, judged from the RAW page length —
  // captured here, before the hidden-user filter below can shorten the page
  // (a filtered page must not read as feed-end) and before the airdrop fold
  // can pad page 0. Upstream's envelope has no total/hasMore of its own, so a
  // full page (INPROCESS_COMMENTS_PAGE_SIZE rows) is the only keep-paging
  // signal there is. Computed only for a well-formed 2xx body; anything else
  // passes through untouched, hasMore-free, like today.
  let upstreamHasMore: boolean | null = null
  if (res.ok && data && typeof data === 'object' && !Array.isArray(data)) {
    const rows = (data as Record<string, unknown>).comments
    if (Array.isArray(rows)) upstreamHasMore = rows.length >= INPROCESS_COMMENTS_PAGE_SIZE
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

  // Fold airdrop rows (labeled below) into the first page and re-sort the
  // whole page newest-first so gifts land in the right temporal spot next to
  // collects. Only touch a well-formed 2xx body; an upstream error passes
  // through untouched (so its status/shape is preserved for the client).
  if (isFirstPage && airdrops.length > 0 && res.ok && data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>
    const existing = Array.isArray(obj.comments) ? (obj.comments as MomentComment[]) : []
    // The patron collection acts as the mint pass, so an airdrop of it is an
    // invitation to the platform ("invited to kismet"); every other collection
    // is a plain gift ("airdropped on kismet"). One moment = one collection, so
    // the label is the same for every row on this page — decide it once.
    const airdropLabel = isPatronCollection(collectionAddress)
      ? AIRDROP_INVITE_COMMENT
      : AIRDROP_GENERIC_COMMENT
    const airdropRows: MomentComment[] = airdrops
      // The recipient is the shown party here, so mirror the comment filter
      // and drop rows whose recipient is an admin-hidden user.
      .filter((a) => !hiddenUsers.has(a.recipient.address.toLowerCase()))
      .map((a) => ({
        sender: a.recipient.address,
        comment: airdropLabel,
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

  // Stamped after the filter/fold mutations so those can't disturb it. The
  // client keys its "load more" button off this instead of guessing from row
  // counts — a page-0 shorter than one upstream page means the button never
  // appears for a feed with nothing more to load.
  if (upstreamHasMore !== null) {
    ;(data as Record<string, unknown>).hasMore = upstreamHasMore
  }
  return NextResponse.json(data, { status: res.status })
}
