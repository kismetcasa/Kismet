import { NextRequest, NextResponse } from 'next/server'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

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

  try {
    const body = (await req.json()) as { json?: object }
    if (!body.json) return NextResponse.json({ error: 'Missing json' }, { status: 400 })

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
