import { NextRequest, NextResponse } from 'next/server'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { getPaidBy } from '@/lib/arweave/paidBy'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifySession } from '@/lib/session'

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

  let body: { json?: object; sessionToken?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.json) return NextResponse.json({ error: 'Missing json' }, { status: 400 })

  if (!body.sessionToken) {
    return NextResponse.json({ error: 'sessionToken required' }, { status: 401 })
  }
  const address = await verifySession(body.sessionToken)
  if (!address) {
    return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 })
  }

  try {
    const turbo = getTurbo()
    const paidBy = getPaidBy()
    const { id } = await turbo.upload({
      data: JSON.stringify(body.json),
      dataItemOpts: {
        tags: [{ name: 'Content-Type', value: 'application/json' }],
        ...(paidBy && { paidBy }),
      },
    })

    return NextResponse.json({ uri: `ar://${id}` })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
