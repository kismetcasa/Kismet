import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`distribute:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })
  }

  const body = await req.json()
  const { splitAddress } = body as { splitAddress?: string }
  if (!splitAddress || !isAddress(splitAddress)) {
    return NextResponse.json({ error: 'valid splitAddress required' }, { status: 400 })
  }

  const res = await fetch(`${INPROCESS_API}/distribute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
  }
  return NextResponse.json(data, { status: res.status })
}
