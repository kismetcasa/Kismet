import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { redis } from '@/lib/redis'
import { checkRateLimit } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  const allowed = await checkRateLimit(`collect:${ip}`, 20, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })
  }

  const body = await req.json()

  const col = (body as { moment?: { collectionAddress?: string } }).moment?.collectionAddress
  const tok = (body as { moment?: { tokenId?: string } }).moment?.tokenId
  if (col && !isAddress(col)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (tok && !/^\d+$/.test(String(tok))) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }

  const res = await fetch(`${INPROCESS_API}/moment/collect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  // Fire-and-forget: increment trending score and record collector
  if (res.ok) {
    const account = (body as { account?: string }).account?.toLowerCase()
    if (col && tok) {
      const colLower = col.toLowerCase()
      redis.zincrby('kismetart:trending', 1, `${colLower}:${tok}`).catch(() => {})
      if (account) {
        redis.zadd(`kismetart:collected:${account}`, { score: Date.now(), member: `${colLower}:${tok}` }).catch(() => {})
      }
    }
  }

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
  }
  return NextResponse.json(data, { status: res.status })
}
