import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifySession } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`sign:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: { hash?: string; sessionToken?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.hash) return NextResponse.json({ error: 'Missing hash' }, { status: 400 })

  if (!body.sessionToken) {
    return NextResponse.json({ error: 'sessionToken required' }, { status: 401 })
  }
  const address = await verifySession(body.sessionToken)
  if (!address) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 })
  }

  const hashBytes = Buffer.from(body.hash, 'base64')
  // Arweave deep-hash chunks are exactly 48 bytes (SHA-384)
  if (hashBytes.length !== 48) {
    return NextResponse.json({ error: 'Invalid hash length' }, { status: 400 })
  }

  const key = process.env.ARWEAVE_JWK
  if (!key) return NextResponse.json({ error: 'Not configured' }, { status: 500 })

  try {
    const jwk = JSON.parse(Buffer.from(key, 'base64').toString())

    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['sign'],
    )

    const sig = await crypto.subtle.sign(
      { name: 'RSA-PSS', saltLength: 32 },
      cryptoKey,
      hashBytes,
    )

    return NextResponse.json({ signature: Buffer.from(sig).toString('base64') })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sign failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
