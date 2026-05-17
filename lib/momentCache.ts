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
  ts: number
}

// Bounded — TTL alone (60s) doesn't bound size between expiries, so a busy
// session could pin every visited moment's comments in memory.
const commentsStore = new LRUCache<string, CommentsEntry>(50)

export function getCachedComments(address: string, tokenId: string): MomentComment[] | undefined {
  const entry = commentsStore.get(detailKey(address, tokenId))
  if (!entry || Date.now() - entry.ts > COMMENTS_TTL) return undefined
  return entry.comments
}

export function setCachedComments(
  address: string,
  tokenId: string,
  comments: MomentComment[],
): void {
  commentsStore.set(detailKey(address, tokenId), { comments, ts: Date.now() })
}
