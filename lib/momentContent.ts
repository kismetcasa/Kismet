import { redis } from './redis'

const keyMomentContent = (addr: string, tokenId: string) =>
  `kismetart:moment-content:${addr.toLowerCase()}:${tokenId}`

// 200KB ceiling. Client cap on writing-moment bodies is 5,000 chars
// (~5KB UTF-8) so this is ~40× headroom for legitimate content while
// still preventing a direct API caller from bloating Redis.
const MAX_CONTENT_BYTES = 200 * 1024

/**
 * Mirror a writing-moment body to KV at mint time so the moment page can
 * render it during Arweave propagation lag. Silently no-ops on oversize
 * input — the body still lives on Arweave via inprocess, so the worst
 * case is an empty SSR fall-through (same as before this mirror existed).
 */
export async function setMomentContent(
  addr: string,
  tokenId: string,
  content: string,
): Promise<void> {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_CONTENT_BYTES) {
    console.warn(
      `[momentContent] skipping mirror for ${addr}:${tokenId}: body is ${bytes}B (max ${MAX_CONTENT_BYTES}B)`,
    )
    return
  }
  await redis.set(keyMomentContent(addr, tokenId), content)
}

export async function getMomentContent(
  addr: string,
  tokenId: string,
): Promise<string | null> {
  return redis.get<string>(keyMomentContent(addr, tokenId))
}
