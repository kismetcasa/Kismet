import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import {
  PERMISSION_BIT_ADMIN,
  PERMISSION_BIT_METADATA,
  readPermissions,
} from '@/lib/permissions'
import { consumeNonce } from '@/lib/profile'
import { setMomentMeta } from '@/lib/notifications'
import { serverBaseClient } from '@/lib/rpc'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Caller must hold ADMIN (2) or METADATA (16) permission on the token —
 * the two bits Zora's 1155 contract honors for `updateTokenURI`. We check
 * token-scoped first, then fall back to collection-wide (tokenId 0) so
 * defaultAdmin holders pass regardless of per-token grants.
 *
 * Uses readPermissions for retry + bigint runtime guard; no separate
 * helper for the ADMIN|METADATA mask since this is the only caller.
 */
async function canUpdateUri(
  collectionAddress: string,
  tokenId: string,
  caller: string,
): Promise<boolean> {
  try {
    const client = serverBaseClient()
    const mask = PERMISSION_BIT_ADMIN | PERMISSION_BIT_METADATA
    const tokenPerms = await readPermissions(
      client,
      collectionAddress as Address,
      BigInt(tokenId),
      caller as Address,
    )
    if ((tokenPerms & mask) !== 0n) return true
    const collectionPerms = await readPermissions(
      client,
      collectionAddress as Address,
      0n,
      caller as Address,
    )
    return (collectionPerms & mask) !== 0n
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`update-uri:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) return errorResponse(500, 'INPROCESS_API_KEY not configured')

  let body: {
    collectionAddress?: string
    tokenId?: string
    newUri?: string
    callerAddress?: string
    signature?: string
    nonce?: string
    chainId?: number
    // Optional: if the caller knows the new display name, pass it so we
    // can refresh the moment-meta KV that drives notifications + cards.
    displayName?: string
  }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const { collectionAddress, tokenId, newUri, callerAddress, signature, nonce } = body

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!tokenId || !/^\d+$/.test(String(tokenId))) {
    return errorResponse(400, 'Invalid tokenId')
  }
  // newUri must be a content URI we recognize. Restricting to ar:// and
  // https:// closes the surface (no data:, no javascript:, no file://).
  if (!newUri || (!newUri.startsWith('ar://') && !newUri.startsWith('https://'))) {
    return errorResponse(400, 'newUri must be ar:// or https://')
  }
  if (!callerAddress || !isAddress(callerAddress)) {
    return errorResponse(401, 'callerAddress required')
  }
  if (!signature || !nonce) {
    return errorResponse(401, 'signature and nonce required')
  }

  // Sign ALL fields the user is consenting to — including newUri so an
  // attacker can't replay a stale signature with a different URI.
  const message = `Update Kismet Art metadata\nCollection: ${collectionAddress.toLowerCase()}\nToken: ${tokenId}\nURI: ${newUri}\nAddress: ${callerAddress.toLowerCase()}\nNonce: ${nonce}`
  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: callerAddress as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })
  } catch {
    return errorResponse(401, 'Invalid signature')
  }
  if (!sigValid) return errorResponse(401, 'Signature verification failed')

  // Verify-then-consume: failed sigs leave the nonce reusable.
  const nonceValid = await consumeNonce(callerAddress, nonce)
  if (!nonceValid) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  // Pre-flight admin check — saves a sponsored-tx revert (and the gas
  // burn) when the caller doesn't actually have permission. Inprocess's
  // smart wallet will fail the on-chain call regardless if the caller
  // isn't admin, but rejecting early is cleaner UX + no wasted budget.
  const authorized = await canUpdateUri(collectionAddress, tokenId, callerAddress)
  if (!authorized) {
    return errorResponse(403, 'Caller is not admin of this token')
  }

  const upstreamBody = {
    moment: {
      collectionAddress,
      tokenId,
      chainId: body.chainId ?? 8453,
    },
    newUri,
  }

  let res: Response
  try {
    res = await fetch(`${INPROCESS_API}/moment/update-uri`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify(upstreamBody),
    })
  } catch (err) {
    console.error(
      `[update-uri] upstream unreachable: ${err instanceof Error ? err.message : String(err)} | request: ${JSON.stringify(upstreamBody)}`,
    )
    return NextResponse.json(
      { error: 'upstream unreachable', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    // Inprocess returned non-JSON (typically an HTML 5xx page from a gateway,
    // or an empty body). Log the raw status + snippet so we can diagnose;
    // surface the status to the client so the toast isn't a bare "upstream
    // error" with no breadcrumb.
    console.error(
      `[update-uri] upstream non-JSON: status=${res.status} body=${text.slice(0, 500)} | request: ${JSON.stringify(upstreamBody)}`,
    )
    return NextResponse.json(
      { error: 'upstream error', status: res.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  // Log non-OK upstream responses (typically the caller's API-key smart
  // wallet isn't admin on this token, or the on-chain tx reverted). Without
  // this, the only signal is the client-side toast — no way to diagnose.
  if (!res.ok) {
    console.error(
      `[update-uri] upstream ${res.status}: ${JSON.stringify(data).slice(0, 500)} | request: ${JSON.stringify(upstreamBody)}`,
    )
  }

  // Refresh moment-meta KV with the new display name so notifications and
  // card overlays stop showing the stale title.
  if (res.ok && body.displayName) {
    after(() =>
      setMomentMeta(collectionAddress.toLowerCase(), tokenId, {
        creator: callerAddress.toLowerCase(),
        name: body.displayName,
      }).catch(() => {}),
    )
  }

  return NextResponse.json(data, { status: res.status })
}
