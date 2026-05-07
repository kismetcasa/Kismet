import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { setMomentMeta } from '@/lib/notifications'
import { serverBaseClient } from '@/lib/rpc'

const PERMISSION_BIT_ADMIN = 2n
const PERMISSION_BIT_METADATA = 16n

const COLLECTION_PERMISSIONS_ABI = [
  {
    name: 'permissions',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Caller must hold ADMIN (2) or METADATA (16) permission on the token —
 * the two bits Zora's 1155 contract honors for `updateTokenURI`. We check
 * token-scoped first, then fall back to collection-wide (tokenId 0) so
 * defaultAdmin holders pass regardless of per-token grants.
 */
async function canUpdateUri(
  collectionAddress: string,
  tokenId: string,
  caller: string,
): Promise<boolean> {
  try {
    const client = serverBaseClient()
    const mask = PERMISSION_BIT_ADMIN | PERMISSION_BIT_METADATA
    const tokenPerms = (await client.readContract({
      address: collectionAddress as Address,
      abi: COLLECTION_PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [BigInt(tokenId), caller as Address],
    })) as bigint
    if ((tokenPerms & mask) !== 0n) return true
    const collectionPerms = (await client.readContract({
      address: collectionAddress as Address,
      abi: COLLECTION_PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [0n, caller as Address],
    })) as bigint
    return (collectionPerms & mask) !== 0n
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`update-uri:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })

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
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { collectionAddress, tokenId, newUri, callerAddress, signature, nonce } = body

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(String(tokenId))) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  // newUri must be a content URI we recognize. Restricting to ar:// and
  // https:// closes the surface (no data:, no javascript:, no file://).
  if (!newUri || (!newUri.startsWith('ar://') && !newUri.startsWith('https://'))) {
    return NextResponse.json({ error: 'newUri must be ar:// or https://' }, { status: 400 })
  }
  if (!callerAddress || !isAddress(callerAddress)) {
    return NextResponse.json({ error: 'callerAddress required' }, { status: 401 })
  }
  if (!signature || !nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 401 })
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
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

  // Verify-then-consume: failed sigs leave the nonce reusable.
  const nonceValid = await consumeNonce(callerAddress, nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  // Pre-flight admin check — saves a sponsored-tx revert (and the gas
  // burn) when the caller doesn't actually have permission. Inprocess's
  // smart wallet will fail the on-chain call regardless if the caller
  // isn't admin, but rejecting early is cleaner UX + no wasted budget.
  const authorized = await canUpdateUri(collectionAddress, tokenId, callerAddress)
  if (!authorized) {
    return NextResponse.json(
      { error: 'Caller is not admin of this token' },
      { status: 403 },
    )
  }

  const res = await fetch(`${INPROCESS_API}/moment/update-uri`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
    body: JSON.stringify({
      moment: {
        collectionAddress,
        tokenId,
        chainId: body.chainId ?? 8453,
      },
      newUri,
    }),
  })

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
  }

  // On success: refresh moment-meta KV with the new display name so
  // notifications and card overlays stop showing the stale title.
  if (res.ok && body.displayName) {
    void setMomentMeta(collectionAddress.toLowerCase(), tokenId, {
      creator: callerAddress.toLowerCase(),
      name: body.displayName,
    }).catch(() => {})
  }

  return NextResponse.json(data, { status: res.status })
}
