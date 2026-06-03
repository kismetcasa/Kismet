import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { redis, FEATURED_KEY, FEATURED_COLLECTIONS_KEY, FEATURED_MOMENT_DISPLAYS_KEY } from '@/lib/redis'
import { verifyPrivilegedSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'

// Parse a zset of `<addr>:<tokenId>` members (score = featuredAt) into refs.
function parseMomentZset(raw: (string | number)[]) {
  const out: { collectionAddress: string; tokenId: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const member = String(raw[i])
    const colonIdx = member.indexOf(':')
    if (colonIdx <= 0) continue
    out.push({
      collectionAddress: member.slice(0, colonIdx),
      tokenId: member.slice(colonIdx + 1),
      featuredAt: Number(raw[i + 1]),
    })
  }
  return out
}

// GET /api/featured — public, returns featured moments, collections, and
// Mint Pass Displays ordered by recency. Existing consumers reading `featured`
// keep working; new consumers also read `featuredCollections` /
// `mintPassDisplays`.
export async function GET() {
  const [rawMoments, rawCollections, rawDisplays] = await Promise.all([
    redis.zrange(FEATURED_KEY, 0, -1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
    redis.zrange(FEATURED_COLLECTIONS_KEY, 0, -1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
    redis.zrange(FEATURED_MOMENT_DISPLAYS_KEY, 0, -1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
  ])

  const featured = parseMomentZset(rawMoments)
  const mintPassDisplays = parseMomentZset(rawDisplays)

  const featuredCollections: { collectionAddress: string; featuredAt: number }[] = []
  for (let i = 0; i + 1 < rawCollections.length; i += 2) {
    featuredCollections.push({
      collectionAddress: String(rawCollections[i]),
      featuredAt: Number(rawCollections[i + 1]),
    })
  }

  return NextResponse.json({ featured, featuredCollections, mintPassDisplays })
}

// POST /api/featured — admin-only. `type=collection` features the whole
// collection (member = lowercase address); default features a single mint
// (member = `<addr>:<tokenId>`). Auth is via HttpOnly session cookie set
// by /api/auth/login.
export async function POST(req: NextRequest) {
  const auth = await verifyPrivilegedSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    type?: 'moment' | 'collection' | 'momentDisplay'
    collectionAddress?: string
    tokenId?: string
  } | null

  if (!body) return errorResponse(400, 'Invalid body')
  const { collectionAddress } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'collectionAddress required')
  }

  if (body.type === 'collection') {
    await redis.zadd(FEATURED_COLLECTIONS_KEY, {
      score: Date.now(),
      member: collectionAddress.toLowerCase(),
    })
    return NextResponse.json({ featured: true })
  }

  if (!body.tokenId) {
    return errorResponse(400, 'tokenId required')
  }
  const member = `${collectionAddress.toLowerCase()}:${body.tokenId}`
  const now = Date.now()

  // A Mint Pass Display is a featured mint with desktop-hero treatment: it
  // lives in BOTH sets (DISPLAY ⊆ FEATURED). Keeping it in FEATURED_KEY means
  // it still renders as a normal featured card in the grid on mobile/miniapp,
  // where the hero layout isn't used — no separate mobile code path needed.
  if (body.type === 'momentDisplay') {
    await Promise.all([
      redis.zadd(FEATURED_MOMENT_DISPLAYS_KEY, { score: now, member }),
      redis.zadd(FEATURED_KEY, { score: now, member }),
    ])
    return NextResponse.json({ featured: true })
  }

  await redis.zadd(FEATURED_KEY, { score: now, member })
  return NextResponse.json({ featured: true })
}

// DELETE /api/featured — admin-only. Mirrors POST shape.
export async function DELETE(req: NextRequest) {
  const auth = await verifyPrivilegedSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    type?: 'moment' | 'collection' | 'momentDisplay'
    collectionAddress?: string
    tokenId?: string
  } | null

  if (!body) return errorResponse(400, 'Invalid body')
  const { collectionAddress } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'collectionAddress required')
  }

  if (body.type === 'collection') {
    await redis.zrem(FEATURED_COLLECTIONS_KEY, collectionAddress.toLowerCase())
    return NextResponse.json({ featured: false })
  }

  if (!body.tokenId) {
    return errorResponse(400, 'tokenId required')
  }
  const member = `${collectionAddress.toLowerCase()}:${body.tokenId}`

  // Demoting a Mint Pass Display drops only the hero treatment — it stays a
  // normal featured card. Unfeaturing a mint clears any hero treatment too
  // (a mint can't be displayed if it isn't featured), preserving DISPLAY ⊆
  // FEATURED.
  if (body.type === 'momentDisplay') {
    await redis.zrem(FEATURED_MOMENT_DISPLAYS_KEY, member)
    return NextResponse.json({ featured: false })
  }

  await Promise.all([
    redis.zrem(FEATURED_KEY, member),
    redis.zrem(FEATURED_MOMENT_DISPLAYS_KEY, member),
  ])
  return NextResponse.json({ featured: false })
}
