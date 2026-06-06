import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'

/**
 * Resolve a "which moment?" reference for the agent endpoints. Accepts either
 * explicit `{ collection, tokenId }` or a Kismet moment `url` — so a user can
 * paste a link ("list this: https://…/moment/0xabc…/42") and the agent doesn't
 * have to know our URL scheme.
 *
 * tokenId is normalized to canonical base-10 (leading zeros stripped) so it
 * keys identically to the rest of the system (the collect/listing routes
 * canonicalize via BigInt the same way).
 */

export interface MomentRef {
  collection: Address
  tokenId: string
}

export type MomentRefResult = MomentRef | { error: string }

export function parseMomentRef(input: {
  collection?: unknown
  tokenId?: unknown
  url?: unknown
}): MomentRefResult {
  // Explicit collection/tokenId wins when present.
  if (input.collection !== undefined || input.tokenId !== undefined) {
    const collection = input.collection
    const tokenId = typeof input.tokenId === 'string' ? input.tokenId : String(input.tokenId ?? '')
    if (!isAddress(collection)) return { error: 'Invalid collection address' }
    if (!isValidTokenId(tokenId)) return { error: 'Invalid tokenId' }
    return { collection, tokenId: BigInt(tokenId).toString() }
  }
  if (typeof input.url === 'string' && input.url.length > 0) {
    return parseMomentUrl(input.url)
  }
  return { error: 'Provide { collection, tokenId } or a moment url' }
}

/** Parse a Kismet moment URL: `…/moment/<collection>/<tokenId>`. Tolerates a
 *  missing scheme, a trailing slash, and any query/hash. Internal — callers use
 *  `parseMomentRef`, which dispatches to this for the URL form. */
function parseMomentUrl(raw: string): MomentRefResult {
  let pathname: string
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`)
    pathname = u.pathname
  } catch {
    return { error: 'Malformed url' }
  }
  const m = pathname.match(/\/moment\/(0x[0-9a-fA-F]{40})\/(\d+)\/?$/)
  if (!m) return { error: 'URL must look like /moment/<collection>/<tokenId>' }
  const collection = m[1]
  const tokenId = m[2]
  if (!isAddress(collection)) return { error: 'Invalid collection address in url' }
  if (!isValidTokenId(tokenId)) return { error: 'Invalid tokenId in url' }
  return { collection, tokenId: BigInt(tokenId).toString() }
}
