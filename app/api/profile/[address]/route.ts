import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage, createPublicClient, http } from 'viem'
import { isAddress } from '@/lib/address'
import { mainnet } from 'viem/chains'
import { redis } from '@/lib/redis'
import { getProfile, upsertProfile, consumeNonce } from '@/lib/profile'
import { errorResponse } from '@/lib/apiResponse'

// Prefer a configured RPC URL (Alchemy / Infura) to avoid rate limits on
// the public default. MAINNET_RPC_URL is the server-only override; falls
// back to NEXT_PUBLIC_MAINNET_RPC_URL (shared with the client-side ENS
// lookup in lib/wagmi.ts) when unset, then to viem's public default.
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL ?? process.env.NEXT_PUBLIC_MAINNET_RPC_URL),
})

const ENS_TTL = 3600      // 1 hour for resolved names
const ENS_FAIL_TTL = 300  // 5 minutes for failures / confirmed no-ENS

async function getCachedEns(address: string): Promise<string | null | undefined> {
  const key = `kismetart:ens:${address.toLowerCase()}`
  try {
    const cached = await redis.get<string>(key)
    if (cached === null) return undefined          // cache miss
    return cached === '' ? null : cached           // '' = confirmed no ENS
  } catch {
    return undefined
  }
}

async function resolveEnsAndCache(address: string): Promise<void> {
  const key = `kismetart:ens:${address.toLowerCase()}`
  try {
    const name = await mainnetClient.getEnsName({ address: address as `0x${string}` })
    await redis.set(key, name ?? '', { ex: ENS_TTL }).catch(() => {})
  } catch {
    await redis.set(key, '', { ex: ENS_FAIL_TTL }).catch(() => {})
  }
}

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  if (!isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  const profile = await getProfile(address)
  if (!profile.username) {
    const cached = await getCachedEns(address)
    if (cached === undefined) {
      after(() => resolveEnsAndCache(address))
    } else if (cached) {
      return NextResponse.json({ profile: { ...profile, ensName: cached } })
    }
  }
  return NextResponse.json({ profile })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  if (!isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }

  let body: { username?: string; avatarUrl?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  if (!body.signature || !body.nonce) {
    return errorResponse(400, 'signature and nonce required')
  }

  if (body.avatarUrl && !body.avatarUrl.startsWith('https://')) {
    return errorResponse(400, 'avatarUrl must be an https URL')
  }

  // Verify the signature proves ownership of the address
  const message = `Update Kismet profile\nAddress: ${address.toLowerCase()}\nNonce: ${body.nonce}`
  const verified = await verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })

  if (!verified) {
    return errorResponse(401, 'Signature verification failed')
  }

  // Consume the nonce only after signature is confirmed valid
  const valid = await consumeNonce(address, body.nonce)
  if (!valid) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  const username = body.username?.trim().slice(0, 30) || undefined
  const profile = await upsertProfile(address, { username, avatarUrl: body.avatarUrl })
  return NextResponse.json({ profile })
}
