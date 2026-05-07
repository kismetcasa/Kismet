import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { DEFAULT_COLLECT_COMMENT } from '@/lib/inprocess'
import { redis } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getMomentMeta, writeNotification } from '@/lib/notifications'

/**
 * Records a successful direct mint. The actual on-chain mint is submitted by
 * the user's wallet via useDirectCollect — Kismet no longer proxies a
 * sponsored collect through inprocess. This endpoint exists purely to bump
 * trending, append the token to the collector's owned list, and notify the
 * creator. Failures here never undo the mint; the client treats it as
 * best-effort.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`collect:${ip}`, 20, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = (await req.json().catch(() => null)) as {
    moment?: { collectionAddress?: string; tokenId?: string }
    account?: string
    amount?: number
    comment?: string
    pricePerToken?: string
    currency?: 'eth' | 'usdc'
  } | null

  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const collectionAddress = body.moment?.collectionAddress
  const tokenId = body.moment?.tokenId
  const account = body.account?.toLowerCase()
  const amount = Number(body.amount ?? 1)
  const comment = body.comment
  const pricePerToken = body.pricePerToken
  const currency = body.currency === 'usdc' || body.currency === 'eth' ? body.currency : undefined

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(String(tokenId))) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (!account || !isAddress(account)) {
    return NextResponse.json({ error: 'Invalid account' }, { status: 400 })
  }

  const collectionLower = collectionAddress.toLowerCase()
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 1

  await Promise.all([
    redis.zincrby('kismetart:trending', 1, `${collectionLower}:${tokenId}`).catch(() => {}),
    redis
      .zadd(`kismetart:collected:${account}`, {
        score: Date.now(),
        member: `${collectionLower}:${tokenId}`,
      })
      .catch(() => {}),
  ])

  // Notification is fire-and-forget — never let it gate the response.
  void (async () => {
    try {
      const meta = await getMomentMeta(collectionLower, tokenId)
      if (!meta) return
      await writeNotification({
        type: 'collect',
        recipient: meta.creator,
        actor: account,
        tokenAddress: collectionLower,
        tokenId,
        tokenName: meta.name,
        amount: safeAmount,
        ...(pricePerToken ? { price: pricePerToken } : {}),
        ...(currency ? { currency } : {}),
        ...(comment && comment !== DEFAULT_COLLECT_COMMENT ? { comment } : {}),
      })
    } catch {
      // notifications are non-critical
    }
  })()

  return NextResponse.json({ ok: true })
}
