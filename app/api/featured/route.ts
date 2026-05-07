import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { redis, FEATURED_KEY, FEATURED_COLLECTIONS_KEY } from '@/lib/redis'

const ADMIN_ADDRESS = (process.env.ADMIN_ADDRESS ?? '').toLowerCase()
const SESSION_TTL = 4 * 60 * 60 * 1000 // 4 hours in ms

async function verifyAdminSession(body: {
  signature?: string
  timestamp?: number
}): Promise<{ error: string; status: number } | null> {
  if (!ADMIN_ADDRESS) return { error: 'Admin not configured', status: 403 }
  if (!body.signature || body.timestamp == null) {
    return { error: 'signature and timestamp required', status: 400 }
  }
  if (Date.now() - body.timestamp > SESSION_TTL) {
    return { error: 'Session expired — please sign in again', status: 401 }
  }

  const message = `Kismet Art admin session\nAddress: ${ADMIN_ADDRESS}\nTimestamp: ${body.timestamp}`
  const verified = await verifyMessage({
    address: ADMIN_ADDRESS as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })
  if (!verified) return { error: 'Signature verification failed', status: 401 }
  return null
}

// GET /api/featured — public, returns both featured moments + collections
// ordered by recency. Existing consumers reading `featured` keep working;
// new consumers also read `featuredCollections`.
export async function GET() {
  const [rawMoments, rawCollections] = await Promise.all([
    redis.zrange(FEATURED_KEY, 0, -1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
    redis.zrange(FEATURED_COLLECTIONS_KEY, 0, -1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
  ])

  const featured: { collectionAddress: string; tokenId: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < rawMoments.length; i += 2) {
    const member = String(rawMoments[i])
    const score = Number(rawMoments[i + 1])
    const colonIdx = member.indexOf(':')
    const collectionAddress = member.slice(0, colonIdx)
    const tokenId = member.slice(colonIdx + 1)
    featured.push({ collectionAddress, tokenId, featuredAt: score })
  }

  const featuredCollections: { collectionAddress: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < rawCollections.length; i += 2) {
    featuredCollections.push({
      collectionAddress: String(rawCollections[i]),
      featuredAt: Number(rawCollections[i + 1]),
    })
  }

  return NextResponse.json({ featured, featuredCollections })
}

// POST /api/featured — admin-only. `type=collection` features the whole
// collection (member = lowercase address); default features a single mint
// (member = `<addr>:<tokenId>`).
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    type?: 'moment' | 'collection'
    collectionAddress?: string
    tokenId?: string
    signature?: string
    timestamp?: number
  }

  const err = await verifyAdminSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const { collectionAddress } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'collectionAddress required' }, { status: 400 })
  }

  if (body.type === 'collection') {
    await redis.zadd(FEATURED_COLLECTIONS_KEY, {
      score: Date.now(),
      member: collectionAddress.toLowerCase(),
    })
    return NextResponse.json({ featured: true })
  }

  if (!body.tokenId) {
    return NextResponse.json({ error: 'tokenId required' }, { status: 400 })
  }
  const member = `${collectionAddress.toLowerCase()}:${body.tokenId}`
  await redis.zadd(FEATURED_KEY, { score: Date.now(), member })
  return NextResponse.json({ featured: true })
}

// DELETE /api/featured — admin-only. Mirrors POST shape.
export async function DELETE(req: NextRequest) {
  const body = (await req.json()) as {
    type?: 'moment' | 'collection'
    collectionAddress?: string
    tokenId?: string
    signature?: string
    timestamp?: number
  }

  const err = await verifyAdminSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const { collectionAddress } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'collectionAddress required' }, { status: 400 })
  }

  if (body.type === 'collection') {
    await redis.zrem(FEATURED_COLLECTIONS_KEY, collectionAddress.toLowerCase())
    return NextResponse.json({ featured: false })
  }

  if (!body.tokenId) {
    return NextResponse.json({ error: 'tokenId required' }, { status: 400 })
  }
  const member = `${collectionAddress.toLowerCase()}:${body.tokenId}`
  await redis.zrem(FEATURED_KEY, member)
  return NextResponse.json({ featured: false })
}
