import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage, isAddress } from 'viem'
import { redis, FEATURED_KEY } from '@/lib/redis'

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

// GET /api/featured — public, returns featured list ordered by recency
export async function GET() {
  const raw = (await redis.zrange(FEATURED_KEY, 0, -1, {
    rev: true,
    withScores: true,
  })) as (string | number)[]

  const featured: { collectionAddress: string; tokenId: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const member = String(raw[i])
    const score = Number(raw[i + 1])
    const colonIdx = member.indexOf(':')
    const collectionAddress = member.slice(0, colonIdx)
    const tokenId = member.slice(colonIdx + 1)
    featured.push({ collectionAddress, tokenId, featuredAt: score })
  }

  return NextResponse.json({ featured })
}

// POST /api/featured — add a mint to featured (admin only)
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    collectionAddress?: string
    tokenId?: string
    signature?: string
    timestamp?: number
  }

  const err = await verifyAdminSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const { collectionAddress, tokenId } = body
  if (!collectionAddress || !isAddress(collectionAddress) || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId required' }, { status: 400 })
  }

  const member = `${collectionAddress.toLowerCase()}:${tokenId}`
  await redis.zadd(FEATURED_KEY, { score: Date.now(), member })
  return NextResponse.json({ featured: true })
}

// DELETE /api/featured — remove a mint from featured (admin only)
export async function DELETE(req: NextRequest) {
  const body = (await req.json()) as {
    collectionAddress?: string
    tokenId?: string
    signature?: string
    timestamp?: number
  }

  const err = await verifyAdminSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const { collectionAddress, tokenId } = body
  if (!collectionAddress || !isAddress(collectionAddress) || !tokenId) {
    return NextResponse.json({ error: 'collectionAddress and tokenId required' }, { status: 400 })
  }

  const member = `${collectionAddress.toLowerCase()}:${tokenId}`
  await redis.zrem(FEATURED_KEY, member)
  return NextResponse.json({ featured: false })
}
