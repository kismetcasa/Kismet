import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage, createPublicClient, http } from 'viem'
import { isAddress } from '@/lib/address'
import { mainnet } from 'viem/chains'
import { redis } from '@/lib/redis'
import { getProfile, upsertProfile, consumeNonce } from '@/lib/profile'

// Prefer a configured RPC URL (Alchemy / Infura) to avoid rate limits on the public default
const mainnetClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL),
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

// Fire-and-forget: resolves ENS and caches the result (or failure) in the background
function resolveEnsInBackground(address: string): void {
  const key = `kismetart:ens:${address.toLowerCase()}`
  mainnetClient.getEnsName({ address: address as `0x${string}` })
    .then((name) => redis.set(key, name ?? '', { ex: ENS_TTL }).catch(() => {}))
    .catch(() => redis.set(key, '', { ex: ENS_FAIL_TTL }).catch(() => {}))
}

export async function GET(
  _: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  if (!isAddress(address)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const profile = await getProfile(address)
  if (!profile.username) {
    const cached = await getCachedEns(address)
    if (cached === undefined) {
      // Cache miss — return immediately and resolve in the background
      resolveEnsInBackground(address)
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
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }

  let body: { username?: string; avatarUrl?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 400 })
  }

  if (body.avatarUrl && !body.avatarUrl.startsWith('https://')) {
    return NextResponse.json({ error: 'avatarUrl must be an https URL' }, { status: 400 })
  }

  // Verify the signature proves ownership of the address
  const message = `Update Kismet Art profile\nAddress: ${address.toLowerCase()}\nNonce: ${body.nonce}`
  const verified = await verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })

  if (!verified) {
    return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })
  }

  // Consume the nonce only after signature is confirmed valid
  const valid = await consumeNonce(address, body.nonce)
  if (!valid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  const username = body.username?.trim().slice(0, 30) || undefined
  const profile = await upsertProfile(address, { username, avatarUrl: body.avatarUrl })
  return NextResponse.json({ profile })
}
