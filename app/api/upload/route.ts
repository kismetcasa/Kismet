import { NextRequest, NextResponse } from 'next/server'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { verifyMessage, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyNonce } from '@/lib/profile'

export const runtime = 'nodejs'
export const maxDuration = 60

function getTurbo() {
  const key = process.env.ARWEAVE_JWK
  if (!key) throw new Error('ARWEAVE_JWK not configured')
  const jwk = JSON.parse(Buffer.from(key, 'base64').toString())
  return TurboFactory.authenticated({ privateKey: jwk })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`upload:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 })
  }

  let body: { json?: object; callerAddress?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.json) return NextResponse.json({ error: 'Missing json' }, { status: 400 })

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

  try {
    const turbo = getTurbo()
    const { id } = await turbo.upload({
      data: JSON.stringify(body.json),
      dataItemOpts: {
        tags: [{ name: 'Content-Type', value: 'application/json' }],
      },
    })

    return NextResponse.json({ uri: `ar://${id}` })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
