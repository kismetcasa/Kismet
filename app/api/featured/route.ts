import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { redis, FEATURED_KEY, FEATURED_COLLECTIONS_KEY, FEATURED_MOMENT_DISPLAYS_KEY, MAX_FEATURED } from '@/lib/redis'
import { verifyPrivilegedSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

// zadd + rank-trim in one atomic MULTI (single Upstash round trip) — the
// TRENDING pattern from /api/collect. The single trim policy lives here so a
// future change can't unbound one write path while capping another.
const zaddCapped = (key: string, member: string, score: number) =>
  redis
    .multi()
    .zadd(key, { score, member })
    .zremrangebyrank(key, 0, -(MAX_FEATURED + 1))
    .exec()

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
    redis.zrange(FEATURED_KEY, 0, MAX_FEATURED - 1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
    redis.zrange(FEATURED_COLLECTIONS_KEY, 0, MAX_FEATURED - 1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
    redis.zrange(FEATURED_MOMENT_DISPLAYS_KEY, 0, MAX_FEATURED - 1, { rev: true, withScores: true }) as Promise<(string | number)[]>,
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
    await zaddCapped(FEATURED_COLLECTIONS_KEY, collectionAddress.toLowerCase(), Date.now())
    await recordAdminAction('featured.add', {
      actor: auth.signer,
      target: collectionAddress.toLowerCase(),
      meta: { type: 'collection' },
    })
    return NextResponse.json({ featured: true })
  }

  if (!body.tokenId) {
    return errorResponse(400, 'tokenId required')
  }
  const member = `${collectionAddress.toLowerCase()}:${body.tokenId}`
  const now = Date.now()

  // A Mint Pass Display is a featured mint with showcase treatment: it lives in
  // BOTH sets (DISPLAY ⊆ FEATURED). Keeping it in FEATURED_KEY means demoting it
  // (zrem from DISPLAYS only, below) leaves it a normal featured card rather
  // than making it vanish from the tab.
  if (body.type === 'momentDisplay') {
    // Single display at a time ("latest wins"): clear any existing display
    // first so exactly one mint is ever the hero. We only del the displays
    // set — cleared members stay in FEATURED_KEY, so a previously-displayed
    // mint demotes to an ordinary featured card rather than vanishing.
    await redis.del(FEATURED_MOMENT_DISPLAYS_KEY)
    // Both writes in ONE MULTI so a partial failure between two round trips
    // can't violate DISPLAY ⊆ FEATURED (see lib/redis.ts). The displays set
    // needs no trim — the del above keeps it single-member.
    await redis
      .multi()
      .zadd(FEATURED_MOMENT_DISPLAYS_KEY, { score: now, member })
      .zadd(FEATURED_KEY, { score: now, member })
      .zremrangebyrank(FEATURED_KEY, 0, -(MAX_FEATURED + 1))
      .exec()
    await recordAdminAction('featured.add', {
      actor: auth.signer,
      target: member,
      meta: { type: 'momentDisplay' },
    })
    return NextResponse.json({ featured: true })
  }

  await zaddCapped(FEATURED_KEY, member, now)
  await recordAdminAction('featured.add', { actor: auth.signer, target: member, meta: { type: 'moment' } })
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
    await recordAdminAction('featured.remove', {
      actor: auth.signer,
      target: collectionAddress.toLowerCase(),
      meta: { type: 'collection' },
    })
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
    await recordAdminAction('featured.remove', {
      actor: auth.signer,
      target: member,
      meta: { type: 'momentDisplay' },
    })
    return NextResponse.json({ featured: false })
  }

  await Promise.all([
    redis.zrem(FEATURED_KEY, member),
    redis.zrem(FEATURED_MOMENT_DISPLAYS_KEY, member),
  ])
  await recordAdminAction('featured.remove', { actor: auth.signer, target: member, meta: { type: 'moment' } })
  return NextResponse.json({ featured: false })
}
