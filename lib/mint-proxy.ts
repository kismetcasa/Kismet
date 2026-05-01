import { type NextRequest, NextResponse } from 'next/server'
import { INPROCESS_API } from './inprocess'
import { redis } from './redis'
import { trackWallet } from './profile'
import { checkRateLimit, getClientIp } from './ratelimit'

export async function proxyMintRequest(
  req: NextRequest,
  rateLimitKey: string,
  endpoint: string,
): Promise<Response> {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`${rateLimitKey}:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = await req.json()
  if (body?.account) void trackWallet(body.account)

  const maxSupplyRaw = body?.token?.maxSupply ?? body?.maxSupply
  if (maxSupplyRaw !== undefined) {
    const ms = Number(maxSupplyRaw)
    if (!Number.isInteger(ms) || ms < 1) {
      return NextResponse.json({ error: 'maxSupply must be a positive integer' }, { status: 400 })
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = process.env.INPROCESS_API_KEY
  if (apiKey) headers['x-api-key'] = apiKey

  const res = await fetch(`${INPROCESS_API}/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const text = await res.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json(
      { error: 'upstream error', status: res.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  if (res.ok && Array.isArray(body?.splits) && body.splits.length >= 2) {
    const r = data as { contractAddress?: string; tokenId?: string }
    if (r.contractAddress && r.tokenId) {
      void redis
        .set(`kismetart:splits:${r.contractAddress.toLowerCase()}:${r.tokenId}`, '1')
        .catch(() => {})
    }
  }

  return NextResponse.json(data, { status: res.status })
}
