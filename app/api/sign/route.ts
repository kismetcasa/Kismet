import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`sign:${ip}`, 10, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Session is bound to an httpOnly cookie — no token in the body. An XSS that
  // can read localStorage no longer has any path to /api/sign.
  const address = await getSessionAddress(req)
  if (!address) {
    return errorResponse(401, 'Sign in to continue')
  }

  let body: { hash?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid JSON')
  }

  if (!body.hash) return errorResponse(400, 'Missing hash')

  const hashBytes = Buffer.from(body.hash, 'base64')
  // Arweave deep-hash chunks are exactly 48 bytes (SHA-384). Anything else
  // is either a misuse or an attempt to sign arbitrary data.
  if (hashBytes.length !== 48) {
    return errorResponse(400, 'Invalid hash length')
  }

  const key = process.env.ARWEAVE_JWK
  if (!key) return errorResponse(500, 'Not configured')

  // Per-address daily cap on media-upload signings. The server only sees the
  // 48-byte deep hash (media streams client → Turbo, see uploadFile.ts), so it
  // can't meter bytes — this count plus the operationally-capped wallet balance
  // (.env.example) are the controls. Turbo calls sign() once per uploadFile, so
  // one debit == one upload. Debit after validation so a malformed body can't
  // burn the bucket.
  const withinQuota = await consumeUserQuota('sign-calls', address, 1, { failClosed: true })
  if (!withinQuota) {
    return errorResponse(429, 'Daily upload signing limit reached — try again tomorrow')
  }

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
    return errorResponse(500, message)
  }
}
