'use client'

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import Link from 'next/link'
import { formatRelativeTime, isPlatformCollectComment, normalizeMomentComments, normalizeTimestampMs, shortAddress, type MomentComment } from '@/lib/inprocess'
import { fetchCreatorProfilesBatch } from '@/lib/profileCache'
import { getCachedComments, getCachedCommentsHasMore, setCachedComments } from '@/lib/momentCache'
import { ProfileAvatar } from './ProfileAvatar'

// The moment detail's "activity" panel: who collected / commented / received
// an airdrop, paged via the comments route's offset support.
//
// Extracted from MomentDetailView for render isolation, not reuse. That
// component is a ~2.5k-line tree (media player included), and while this
// state lived there every "load more" click re-rendered ALL of it three
// times over — loading flip, page append, then the sender-profile batch
// landing — a visible main-thread stall on desktop. Owning the state here
// shrinks those renders to this list alone, and the memo() wrapper blocks
// the reverse direction too: the parent's frequent unrelated re-renders
// (polls, media state, collect flow) no longer reconcile hundreds of
// activity rows. All props are primitives, so memo's shallow compare holds;
// keep it that way — an object/callback prop would silently void it.

// Stable identity for one activity row across paginated fetches. Collect
// comments and the airdrop rows the route folds onto page 0 share the
// sender+timestamp space, so `kind` disambiguates. Used as the React key AND
// for cross-page dedup, so a new collect shifting the newest-first feed can't
// surface a boundary row twice.
//
// Dereferences `sender` unguarded, which is safe for one reason only: every
// path that turns a response into MomentComment[] goes through
// normalizeMomentComments first. That is the invariant this file relies on —
// `res.json()` is `any`, so without it the cast below is an unchecked claim
// and this line is where a malformed row takes the whole panel down.
function activityRowKey(c: MomentComment): string {
  return `${c.sender.toLowerCase()}:${c.timestamp}:${c.kind ?? 'collect'}`
}

// Drop rows sharing an activityRowKey, preserving first-seen order. The fetch
// and append paths dedupe as they go; this also covers the initial state
// seeded from the shared cache (MomentCard writes the raw page-0), so
// `comments` is dup-free on every entry path and row keys stay unique by
// construction.
function dedupeActivity(rows: MomentComment[]): MomentComment[] {
  const seen = new Set<string>()
  return rows.filter((c) => {
    const k = activityRowKey(c)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

interface Props {
  address: string
  tokenId: string
  // Bumped by MomentDetailView after a collect or an on-chain comment (on a
  // delay that gives In Process time to index). Each bump forces a page-0
  // refresh past the shared cache so the just-added row lands.
  refreshNonce: number
}

function MomentActivityImpl({ address, tokenId, refreshNonce }: Props) {
  const [comments, setComments] = useState<MomentComment[]>(
    () => dedupeActivity(getCachedComments(address, tokenId) ?? [])
  )
  const [commentsLoading, setCommentsLoading] = useState(
    () => getCachedComments(address, tokenId) === undefined
  )
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  // Seeded from the shared cache under the same rule fetchComments applies to
  // a live page 0: a real (non-airdrop) comment row must exist for the offset
  // cursor to advance past, and the route's hasMore (recorded by the cache
  // writer — MomentCard's hover-prefetch or a prior visit here) must not have
  // said "no". An entry whose writer never saw the field (response predates
  // it) passes the second check and degrades to the old self-terminating
  // behavior. A cold page-0 fetch overwrites this either way.
  const [hasMoreComments, setHasMoreComments] = useState(() => {
    const cached = getCachedComments(address, tokenId)
    return (
      (cached?.some((c) => c.kind !== 'airdrop') ?? false) &&
      getCachedCommentsHasMore(address, tokenId) !== false
    )
  })
  // Row offset into inprocess's comment feed for the NEXT page. Excludes the
  // airdrop rows the route folds onto page 0, and advances by each page's RAW
  // returned count (never the deduped/displayed count) so a boundary re-fetch
  // can't stall it. null until page 0 (or a cache-restore load-more) seeds it.
  const commentOffsetRef = useRef<number | null>(null)
  const seenCommentsRef = useRef<Set<string> | null>(null)
  const [commentSenderProfiles, setCommentSenderProfiles] = useState<Record<string, { name: string; avatarUrl?: string }>>({})

  // Fetch page 0 of activity. Skips when already seeded from the shared cache
  // unless `force` (post-collect refresh) — which bypasses the cache to pull
  // the just-added comment and resets pagination to the newest page.
  const fetchComments = useCallback(async (force = false) => {
    if (!force && getCachedComments(address, tokenId)) return
    // A forced refresh already has the list on screen — keep it visible and
    // swap in place rather than blanking to the empty state.
    if (!force) setCommentsLoading(true)
    try {
      const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        const fetched: MomentComment[] = normalizeMomentComments(data.comments)
        const deduped = dedupeActivity(fetched)
        seenCommentsRef.current = new Set(deduped.map(activityRowKey))
        // Next page starts after page 0's real comments; airdrop rows live only
        // in Kismet's fold, not inprocess's offset space, so exclude them.
        commentOffsetRef.current = fetched.filter((c) => c.kind !== 'airdrop').length
        // More pages exist only when the route's raw-page-length signal says so
        // (hasMore — computed upstream of its hidden-user filter, so a
        // shortened page can't read as feed-end) AND page 0 carries a real
        // comment for the offset cursor to advance past — an airdrop-only page
        // 0 would refetch offset 0 forever. A response without the field (older
        // route during a deploy) degrades to the any-real-comment heuristic,
        // which load-more self-terminates.
        const hasMore = fetched.some((c) => c.kind !== 'airdrop') && data.hasMore !== false
        setHasMoreComments(hasMore)
        setCachedComments(address, tokenId, deduped, hasMore)
        setComments(deduped)
      }
    } catch {
      // comments are non-critical
    } finally {
      setCommentsLoading(false)
    }
  }, [address, tokenId])

  // Load the next page of activity: paginate inprocess's comment feed by row
  // offset and append. Redis-neutral — the route folds airdrops on page 0
  // only, so pages > 0 are pure upstream comments and touch no Kismet state.
  const loadMoreComments = useCallback(async () => {
    if (loadingMoreComments || !hasMoreComments) return
    // Cache-restore path: the refs were never seeded by a page-0 fetch (the
    // list came from the shared cache), so derive them from what's on screen.
    let seenInit = seenCommentsRef.current
    if (seenInit === null) {
      seenInit = new Set(comments.map(activityRowKey))
      seenCommentsRef.current = seenInit
    }
    const seen = seenInit
    const startOffset =
      commentOffsetRef.current ?? comments.filter((c) => c.kind !== 'airdrop').length
    setLoadingMoreComments(true)
    try {
      const params = new URLSearchParams({
        collectionAddress: address,
        tokenId,
        chainId: '8453',
        offset: String(startOffset),
      })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        const page: MomentComment[] = normalizeMomentComments(data.comments)
        // Advance by the RAW page size before deduping so an all-duplicate
        // boundary page still moves the cursor forward.
        commentOffsetRef.current = startOffset + page.length
        // The feed continues only while rows keep arriving AND the route's
        // raw-page-length signal (hasMore, computed before its hidden-user
        // filter can shorten a page) hasn't declared upstream exhausted — so
        // the final short page retires the button without a dead click. An
        // empty page still terminates unconditionally: the cursor advances by
        // received rows, so a page filtered down to nothing can't move it and
        // retrying would refetch the same page forever. A response without
        // hasMore (older route during a deploy) keeps the old empty-page-only
        // termination.
        const nextHasMore = page.length > 0 && data.hasMore !== false
        setHasMoreComments(nextHasMore)
        const fresh = page.filter((c) => {
          const k = activityRowKey(c)
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        if (fresh.length > 0) {
          setComments((prev) => {
            const next = [...prev, ...fresh]
            // Airdrop rows are folded onto page 0 only, so a later (older)
            // comment page can carry rows that belong BELOW an already-shown
            // airdrop. Re-sort by normalized timestamp — the exact comparator
            // the route applies to page 0 (lib inprocess normalizeTimestampMs,
            // `|| 0` NaN guard) — but only when an airdrop is present, so pure-
            // comment feeds keep inprocess's order untouched and never reflow.
            if (next.some((c) => c.kind === 'airdrop')) {
              next.sort(
                (x, y) =>
                  (normalizeTimestampMs(y.timestamp) || 0) -
                  (normalizeTimestampMs(x.timestamp) || 0),
              )
            }
            setCachedComments(address, tokenId, next, nextHasMore)
            return next
          })
        } else if (!nextHasMore) {
          // Nothing new to append, but the feed just ended — record the
          // terminal hasMore so a remount inside the cache TTL doesn't
          // resurrect the button.
          setCachedComments(address, tokenId, comments, nextHasMore)
        }
      }
    } catch {
      // non-critical — the button remains for a retry
    } finally {
      setLoadingMoreComments(false)
    }
  }, [address, tokenId, comments, hasMoreComments, loadingMoreComments])

  useEffect(() => { fetchComments() }, [fetchComments])

  // Parent-requested force refresh (post-collect / post-onchain-comment).
  // Ref-compare skips the mount value — the initial load belongs to the
  // effect above — so only a real bump re-pulls page 0 past the cache.
  const prevRefreshNonceRef = useRef(refreshNonce)
  useEffect(() => {
    if (refreshNonce === prevRefreshNonceRef.current) return
    prevRefreshNonceRef.current = refreshNonce
    void fetchComments(true)
  }, [refreshNonce, fetchComments])

  // Batch-resolve activity-row sender profiles (name + avatar) via the shared
  // cache + a single /api/profiles request, rather than one /api/profile call
  // per sender. In-process comments carry only the bare sender address, so
  // every unique sender needs identity resolution; collapsing that fan-out
  // into one round-trip is what keeps the activity list from trickling in.
  // Re-running with the full sender list on every append is deliberate:
  // already-resolved addresses are served from profileCache's LRU without a
  // network hit, so each run only fetches the new page's senders.
  useEffect(() => {
    if (comments.length === 0) return
    let cancelled = false
    const senders = Array.from(new Set(comments.map((c) => c.sender.toLowerCase())))
    fetchCreatorProfilesBatch(senders).then((profiles) => {
      if (cancelled) return
      setCommentSenderProfiles((prev) => ({ ...prev, ...profiles }))
    })
    return () => { cancelled = true }
  }, [comments])

  if (commentsLoading || comments.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-mono text-subtle uppercase tracking-wider">activity</p>
      <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
        {comments.map((c) => {
          const profile = commentSenderProfiles[c.sender.toLowerCase()]
          const displayName = profile?.name ?? shortAddress(c.sender)
          // Airdrop rows are gifts the recipient didn't buy. The
          // comments route already stamped the right label into
          // `comment` per collection — "invited to kismet" for the
          // patron/mint-pass collection, "airdropped on kismet"
          // otherwise — so just render it. `sender` is the recipient.
          const isAirdrop = c.kind === 'airdrop'
          const isDefault = isPlatformCollectComment(c.comment)
          return (
            <div key={activityRowKey(c)} className="flex gap-2 items-center">
              <Link href={`/profile/${c.sender}`} className="flex-shrink-0">
                <ProfileAvatar
                  address={c.sender}
                  avatarUrl={profile?.avatarUrl}
                  size={20}
                  clickable
                  // Most rows sit below the fold of this max-h-64 scroller;
                  // lazy keeps a 20-row append from bursting 20 image
                  // fetches + decodes into the click's frame budget.
                  lazy
                />
              </Link>
              <Link
                href={`/profile/${c.sender}`}
                className="text-[11px] font-mono text-muted flex-shrink-0 hover:text-dim transition-colors"
              >
                {displayName}
              </Link>
              <span className="text-xs font-mono text-dim flex-1 break-words leading-relaxed">
                {isAirdrop
                  ? c.comment
                  : isDefault
                    ? 'collected on kismet'
                    : c.comment}
              </span>
              <span className="text-[10px] font-mono text-subtle flex-shrink-0">
                {formatRelativeTime(c.timestamp)}
              </span>
            </div>
          )
        })}
        {hasMoreComments && (
          <button
            type="button"
            onClick={() => void loadMoreComments()}
            disabled={loadingMoreComments}
            className="mt-1 self-center text-[10px] font-mono text-muted hover:text-dim transition-colors disabled:opacity-50"
          >
            {loadingMoreComments ? 'loading…' : 'load more'}
          </button>
        )}
      </div>
    </div>
  )
}

export const MomentActivity = memo(MomentActivityImpl)
