import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, verifyMessage, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { base } from 'viem/chains'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { getMomentMeta, writeNotification } from '@/lib/notifications'

const PERMISSION_BIT_ADMIN = 2n

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
 * Fallback admin check via on-chain `permissions` read. Inprocess's indexer
 * runs minutes behind a fresh mint, so a legit creator can transiently fail
 * the inprocess /moment lookup. The on-chain ADMIN bit is authoritative for
 * any token Zora minted, regardless of indexer state.
 */
async function isOnChainAdmin(collectionAddress: string, tokenId: string, caller: string): Promise<boolean> {
  try {
    const client = createPublicClient({ chain: base, transport: http() })
    const tokenScopedPerms = (await client.readContract({
      address: collectionAddress as Address,
      abi: COLLECTION_PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [BigInt(tokenId), caller as Address],
    })) as bigint
    if ((tokenScopedPerms & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN) return true
    // Collection-wide admin (tokenId 0) also counts — that's where defaultAdmin lives.
    const collectionWidePerms = (await client.readContract({
      address: collectionAddress as Address,
      abi: COLLECTION_PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [0n, caller as Address],
    })) as bigint
    return (collectionWidePerms & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`airdrop:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })

  let body: {
    recipients?: { recipientAddress: string; tokenId: string }[]
    collectionAddress?: string
    callerAddress?: string
    signature?: string
    nonce?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.collectionAddress || !isAddress(body.collectionAddress)) {
    return NextResponse.json({ error: 'valid collectionAddress required' }, { status: 400 })
  }
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) {
    return NextResponse.json({ error: 'recipients required' }, { status: 400 })
  }
  for (const r of body.recipients) {
    if (!isAddress(r.recipientAddress)) {
      return NextResponse.json({ error: `invalid recipientAddress: ${r.recipientAddress}` }, { status: 400 })
    }
    // tokenId interpolated into the signed message and the moment-meta KV
    // key — restrict to digits to prevent any control-char shenanigans.
    if (!r.tokenId || !/^\d+$/.test(String(r.tokenId))) {
      return NextResponse.json({ error: `invalid tokenId: ${r.tokenId}` }, { status: 400 })
    }
  }

  // Verify the caller is the moment creator via wallet signature
  if (!body.callerAddress || !isAddress(body.callerAddress)) {
    return NextResponse.json({ error: 'callerAddress required' }, { status: 401 })
  }
  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 401 })
  }

  const tokenId = body.recipients[0].tokenId
  const message = `Airdrop moment on Kismet Art\nCollection: ${body.collectionAddress.toLowerCase()}\nToken: ${tokenId}\nAddress: ${body.callerAddress.toLowerCase()}\nNonce: ${body.nonce}`

  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: body.callerAddress as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

  // Consume nonce only after signature is verified — failed sig leaves nonce reusable
  const nonceValid = await consumeNonce(body.callerAddress, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  // Confirm caller is creator or admin. Inprocess's /moment endpoint
  // returns MomentDetail with `momentAdmins: string[]` — the creator is
  // momentAdmins[0], delegated admins follow. Off-chain admin grants are
  // captured here. On-chain ADMIN bit is the fallback for fresh tokens
  // the indexer hasn't picked up yet.
  const callerLower = body.callerAddress.toLowerCase()
  let authorized = false
  try {
    const momentUrl = new URL(`${INPROCESS_API}/moment`)
    momentUrl.searchParams.set('collectionAddress', body.collectionAddress)
    momentUrl.searchParams.set('tokenId', tokenId)
    momentUrl.searchParams.set('chainId', '8453')
    const momentRes = await fetch(momentUrl.toString(), { headers: { Accept: 'application/json' } })
    if (momentRes.ok) {
      const momentData = (await momentRes.json()) as { momentAdmins?: unknown }
      const adminsLower = Array.isArray(momentData.momentAdmins)
        ? momentData.momentAdmins
            .filter((a): a is string => typeof a === 'string')
            .map((a) => a.toLowerCase())
        : []
      authorized = adminsLower.includes(callerLower)
    }
  } catch {
    // Fall through to on-chain check.
  }
  if (!authorized) {
    authorized = await isOnChainAdmin(body.collectionAddress, tokenId, body.callerAddress)
  }
  if (!authorized) {
    return NextResponse.json({ error: 'Only the moment creator or an admin may airdrop' }, { status: 403 })
  }

  try {
    const res = await fetch(`${INPROCESS_API}/moment/airdrop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      // Inprocess expects the same `moment: { collectionAddress, tokenId,
      // chainId }` envelope used by /moment/update-uri (their Zod validator
      // returns "moment: expected object, received undefined" when omitted).
      // Recipients ride alongside as a flat array of { recipientAddress,
      // tokenId } so per-recipient tokenIds are still permitted by the
      // upstream schema.
      body: JSON.stringify({
        moment: {
          collectionAddress: body.collectionAddress,
          tokenId,
          chainId: 8453,
        },
        recipients: body.recipients,
      }),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
    }

    // Fan-out: notify each airdrop recipient that they received a token from
    // the creator. Fire-and-forget — KV failures never undo the on-chain
    // airdrop. Mirrors the mint follower-fanout pattern in lib/mint-proxy.ts.
    if (res.ok) {
      void (async () => {
        try {
          const collectionLower = body.collectionAddress!.toLowerCase()
          const meta = await getMomentMeta(collectionLower, tokenId).catch(() => null)
          await Promise.all(
            body.recipients!
              .filter((r) => r.recipientAddress.toLowerCase() !== body.callerAddress!.toLowerCase())
              .map((r) =>
                writeNotification({
                  type: 'airdrop',
                  recipient: r.recipientAddress,
                  actor: body.callerAddress,
                  tokenAddress: collectionLower,
                  tokenId: r.tokenId,
                  tokenName: meta?.name,
                }),
              ),
          )
        } catch {
          // notifications are non-critical
        }
      })()
    }

    return NextResponse.json(parsed, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 })
  }
}
