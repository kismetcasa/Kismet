import { NextRequest, NextResponse } from 'next/server'
import { TurboFactory } from '@ardrive/turbo-sdk'
import { getPaidBy } from '@/lib/arweave/paidBy'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'

export const runtime = 'nodejs'

// Hard cap on uploaded JSON metadata size. Mirrors the client-side 50 MB cap
// in MintForm, but enforced server-side too — a direct caller with a valid
// session shouldn't be able to drain Turbo credit with arbitrarily large
// uploads.
const MAX_BODY_BYTES = 50 * 1024 * 1024

function getTurbo() {
  const key = process.env.ARWEAVE_JWK
  if (!key) throw new Error('ARWEAVE_JWK not configured')
  const jwk = JSON.parse(Buffer.from(key, 'base64').toString())
  return TurboFactory.authenticated({ privateKey: jwk })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`upload:${ip}`, 30, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const address = await getSessionAddress(req)
  if (!address) {
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  const contentLength = Number(req.headers.get('content-length') ?? 0)
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const contentType = req.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'Unsupported content type' }, { status: 415 })
  }

  let body: { json?: object }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.json) return NextResponse.json({ error: 'Missing json' }, { status: 400 })

  // Re-stringify and re-check size — defends against missing/forged
  // content-length and against payloads that decode larger than they appear.
  const serialized = JSON.stringify(body.json)
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  try {
    const turbo = getTurbo()
    const paidBy = getPaidBy()
    const { id } = await turbo.upload({
      data: serialized,
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
