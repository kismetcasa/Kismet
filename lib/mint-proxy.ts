import { type NextRequest, NextResponse } from 'next/server'
import { INPROCESS_API } from './inprocess'
import { redis } from './redis'
import { trackWallet } from './profile'
import { checkRateLimit, getClientIp } from './ratelimit'
import { setMomentMeta, writeNotification } from './notifications'

export async function proxyMintRequest(
  req: NextRequest,
  rateLimitKey: string,
  endpoint: string,
): Promise<Response> {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`${rateLimitKey}:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = (await req.json()) as Record<string, unknown>
  const account = typeof body?.account === 'string' ? body.account : undefined
  if (account) void trackWallet(account)

  const tokenObj = (body?.token as Record<string, unknown> | undefined) ?? {}
  const maxSupplyRaw = tokenObj.maxSupply ?? body?.maxSupply
  if (maxSupplyRaw !== undefined) {
    const ms = Number(maxSupplyRaw)
    if (!Number.isInteger(ms) || ms < 1) {
      return NextResponse.json({ error: 'maxSupply must be a positive integer' }, { status: 400 })
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = process.env.INPROCESS_API_KEY
  if (apiKey) headers['x-api-key'] = apiKey

  const upstream = await fetch(`${INPROCESS_API}/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const text = await upstream.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return NextResponse.json(
      { error: 'upstream error', status: upstream.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  if (upstream.ok) {
    const r = data as { contractAddress?: string; tokenId?: string }
    const contractAddress = r.contractAddress
    const tokenId = r.tokenId

    if (contractAddress && tokenId && account) {
      const name =
        (typeof body?.name === 'string' && body.name) ||
        (typeof tokenObj.name === 'string' && (tokenObj.name as string)) ||
        undefined

      void setMomentMeta(contractAddress, tokenId, { creator: account, name }).catch(() => {})
      void writeNotification({
        type: 'mint',
        recipient: account,
        tokenAddress: contractAddress,
        tokenId,
        tokenName: name,
      })

      if (Array.isArray(body?.splits) && (body.splits as unknown[]).length >= 2) {
        void redis
          .set(`kismetart:splits:${contractAddress.toLowerCase()}:${tokenId}`, '1')
          .catch(() => {})
      }
    }
  }

  return NextResponse.json(data, { status: upstream.status })
}
