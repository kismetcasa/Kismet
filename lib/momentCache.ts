import type { MomentDetail, MomentComment } from './inprocess'

// ─── Detail cache ─────────────────────────────────────────────────────────────
// Populated by feed/card renders and consumed by MomentDetailView so the
// intercepted-route overlay (and full-page detail) can render immediately
// without re-fetching what the feed already pulled.

const detailStore = new Map<string, MomentDetail>()

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

const commentsStore = new Map<string, CommentsEntry>()

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
