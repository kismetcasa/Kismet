import type { MomentDetail, MomentComment } from './inprocess'
import { LRUCache } from './lruCache'

// ─── Detail cache ─────────────────────────────────────────────────────────────
// Module-level store written + read by MomentDetailView so reopening a
// moment you just viewed (IR overlay → close → re-open, or canonical →
// back → re-open) renders instantly with the last-known detail while the
// background fetch revalidates. Hide/unhide and comment-post flows write
// the optimistic result here too so the next surface sees the update.
// Bounded to 100 entries (~500KB) so a long session doesn't pin memory.

const detailStore = new LRUCache<string, MomentDetail>(100)

function detailKey(address: string, tokenId: string) {
  return `${address.toLowerCase()}:${tokenId}`
}

export function getCachedDetail(address: string, tokenId: string): MomentDetail | undefined {
  return detailStore.get(detailKey(address, tokenId))
}

export function setCachedDetail(address: string, tokenId: string, detail: MomentDetail): void {
  detailStore.set(detailKey(address, tokenId), detail)
}

// ─── Comments cache ───────────────────────────────────────────────────────────

const COMMENTS_TTL = 60_000

interface CommentsEntry {
  comments: MomentComment[]
  // The comments route's hasMore as of the last page merged into `comments`
  // (raw upstream page length vs INPROCESS_COMMENTS_PAGE_SIZE, computed
  // server-side before hidden-user filtering). undefined = the writer didn't
  // see the field (response predates it) — readers fall back to their own
  // conservative default instead of trusting an absent signal.
  hasMore?: boolean
  ts: number
}

// Bounded — TTL alone (60s) doesn't bound size between expiries, so a busy
// session could pin every visited moment's comments in memory.
const commentsStore = new LRUCache<string, CommentsEntry>(50)

function getCommentsEntry(address: string, tokenId: string): CommentsEntry | undefined {
  const entry = commentsStore.get(detailKey(address, tokenId))
  if (!entry || Date.now() - entry.ts > COMMENTS_TTL) return undefined
  return entry
}

export function getCachedComments(address: string, tokenId: string): MomentComment[] | undefined {
  return getCommentsEntry(address, tokenId)?.comments
}

export function getCachedCommentsHasMore(address: string, tokenId: string): boolean | undefined {
  return getCommentsEntry(address, tokenId)?.hasMore
}

export function setCachedComments(
  address: string,
  tokenId: string,
  comments: MomentComment[],
  hasMore?: boolean,
): void {
  commentsStore.set(detailKey(address, tokenId), { comments, hasMore, ts: Date.now() })
}
