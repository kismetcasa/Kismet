import { redis } from './redis'

const keyMomentContent = (addr: string, tokenId: string) =>
  `kismetart:moment-content:${addr.toLowerCase()}:${tokenId}`

// 200KB ceiling. Client cap on writing-moment bodies is 5,000 chars
// (~5KB UTF-8) so this is ~40× headroom for legitimate content while
// still preventing a direct API caller from bloating Redis.
const MAX_CONTENT_BYTES = 200 * 1024

/**
 * Mirrors the raw body of a text ("writing") moment to KV at mint time so
 * the moment page can render it during Arweave propagation lag — and as
 * a permanent fallback if Turbo's tx ID never propagates to gateways.
 * Inprocess uploads the body server-side, returning a `metadata.content.uri`
 * we don't control; if it 404s, the URI is on-chain so re-uploading
 * isn't an option.
 *
 * Stored without TTL — on-chain references are permanent. Oversized
 * bodies (> MAX_CONTENT_BYTES) are skipped: the body still lives on
 * Arweave via inprocess, so the worst case degrades to an empty SSR
 * fall-through (same as pre-mirror).
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
  try {
    await redis.set(keyMomentContent(addr, tokenId), content)
  } catch (err) {
    // Don't fail the mint over a KV miss — the body is still on Arweave
    // (eventually). Surface in logs so we can spot a misconfigured Redis
    // instead of silently degrading.
    console.error('[momentContent] set failed', {
      addr,
      tokenId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Read the mirrored body. Returns null when the moment isn't text, was
 * minted before the mirror existed, or KV is unreachable. Callers should
 * use this purely as a fallback after the Arweave fetch fails.
 */
export async function getMomentContent(
  addr: string,
  tokenId: string,
): Promise<string | null> {
  try {
    const v = await redis.get<string | null>(keyMomentContent(addr, tokenId))
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}
