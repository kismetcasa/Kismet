import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyNonce } from '@/lib/profile'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`sign:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: { hash?: string; callerAddress?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.hash) return NextResponse.json({ error: 'Missing hash' }, { status: 400 })

  // Require proof of wallet ownership
  if (!body.callerAddress || !isAddress(body.callerAddress)) {
    return NextResponse.json({ error: 'callerAddress required' }, { status: 401 })
  }
  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 401 })
  }

  const nonceValid = await verifyNonce(body.callerAddress, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  const message = `Upload on Kismet Art\nAddress: ${body.callerAddress.toLowerCase()}\nNonce: ${body.nonce}`
  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: body.callerAddress as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

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
