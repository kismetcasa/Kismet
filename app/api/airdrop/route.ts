import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`airdrop:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })

  let body: { recipients?: { recipientAddress: string; tokenId: string }[]; collectionAddress?: string }
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
  }

  try {
    const res = await fetch(`${INPROCESS_API}/moment/airdrop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({ recipients: body.recipients, collectionAddress: body.collectionAddress }),
    })
    const text = await res.text()
    try {
      return NextResponse.json(JSON.parse(text), { status: res.status })
    } catch {
      return NextResponse.json({ error: 'upstream error', detail: text.slice(0, 200) }, { status: 502 })
    }
  } catch {
    return NextResponse.json({ error: 'upstream unreachable' }, { status: 502 })
  }
}
