import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { ZORA_1155_TOKEN_INFO_ABI } from '@/lib/zoraMint'
import { gatewayUrls } from '@/lib/arweave/gateways'
import { pickMetadataName } from '@/lib/momentUriEdit'
import { getMomentMeta, setMomentMeta } from '@/lib/notifications'
import { serverBaseClient } from '@/lib/rpc'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Re-sync Kismet's own moment-meta KV (the display name that drives
 * notifications + card overlays — lib/notifications MomentMeta) for one token
 * from CHAIN truth. Called by the artwork editor right after its
 * updateTokenURI receipt lands — the metadata twin of /api/moment/sale-refresh.
 *
 * Deliberately UNAUTHENTICATED and trustless: the request names a token and
 * never supplies a name or a URI. The route reads uri(tokenId) on-chain,
 * fetches that JSON through the Arweave gateway pool, and writes only what it
 * read. The worst a caller can do is refresh an entry to its already-correct
 * value, so a signature would protect nothing. Rate-limited to bound the RPC +
 * gateway spend. Best-effort by design: propagation lag, a gateway miss, or a
 * missing KV row answers {refreshed:false}, never an error — the editor's
 * optimistic state is what the artist sees, and inprocess's chain indexer
 * converges the feed metadata on its own cron regardless.
 *
 * SSRF: only ar:// and ipfs:// pointers are fetched. gatewayUrls passes any
 * other scheme through verbatim, so an https:// token URI is never requested
 * from here (the name refresh is simply skipped for it).
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`meta-refresh:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  let body: { collectionAddress?: string; tokenId?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  const { collectionAddress, tokenId } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!tokenId || !isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }

  let uri: string
  try {
    const info = await serverBaseClient().readContract({
      address: collectionAddress as Address,
      abi: ZORA_1155_TOKEN_INFO_ABI,
      functionName: 'getTokenInfo',
      args: [BigInt(tokenId)],
    })
    uri = info.uri
  } catch (err) {
    console.error('[meta-refresh] on-chain uri read failed', {
      collectionAddress,
      tokenId,
      err: err instanceof Error ? err.message : String(err),
    })
    return errorResponse(502, 'Could not read the token URI on-chain')
  }

  const name = await fetchMetadataName(uri)
  if (!name) return NextResponse.json({ ok: true, refreshed: false, uri })

  // Only refresh an entry that already exists. `creator` is the attribution +
  // authorization key, written once at mint; fabricating one here would launder
  // a possibly-wrong attribution into the trusted KV layer (see the timeline
  // stitch's pin note in app/api/timeline). setMomentMeta merges, so the
  // established creator / createdAt pin are preserved either way.
  let existing: Awaited<ReturnType<typeof getMomentMeta>> = null
  try {
    existing = await getMomentMeta(collectionAddress, tokenId)
  } catch {
    existing = null
  }
  if (!existing?.creator) return NextResponse.json({ ok: true, refreshed: false, uri, name })
  try {
    await setMomentMeta(collectionAddress, tokenId, { creator: existing.creator, name })
  } catch (err) {
    console.error('[meta-refresh] KV write failed', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ ok: true, refreshed: false, uri, name })
  }
  return NextResponse.json({ ok: true, refreshed: true, uri, name })
}

async function fetchMetadataName(uri: string): Promise<string | undefined> {
  if (!uri.startsWith('ar://') && !uri.startsWith('ipfs://')) return undefined
  for (const url of gatewayUrls(uri)) {
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
      if (!res.ok) continue
      const name = pickMetadataName(await res.json())
      if (name) return name
    } catch {
      // Gateway miss / timeout / non-JSON — try the next gateway.
    }
  }
  return undefined
}
