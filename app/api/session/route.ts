import { NextRequest, NextResponse } from 'next/server'
import { isAddress, verifyMessage } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { consumeNonce } from '@/lib/profile'
import { createSession, revokeSession } from '@/lib/session'

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`session:${ip}`, 10, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  let body: { address?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'Valid address required' }, { status: 400 })
  }
  if (!body.signature || !body.nonce) {
    return NextResponse.json({ error: 'signature and nonce required' }, { status: 400 })
  }

  const message = `Sign in to Kismet Art\nAddress: ${body.address.toLowerCase()}\nNonce: ${body.nonce}`
  let sigValid = false
  try {
    sigValid = await verifyMessage({
      address: body.address as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    })
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (!sigValid) return NextResponse.json({ error: 'Signature verification failed' }, { status: 401 })

  // Consume nonce only after signature verifies — a failed sig leaves the
  // nonce reusable, otherwise an attacker who knows a victim's address could
  // burn nonces with bogus signatures and DoS them out of signing in.
  // (Same pattern as /api/airdrop, /api/profile, /api/follow, /api/listings.)
  const nonceValid = await consumeNonce(body.address, body.nonce)
  if (!nonceValid) {
    return NextResponse.json({ error: 'Invalid or expired nonce' }, { status: 401 })
  }

  const sessionToken = await createSession(body.address)
  return NextResponse.json({ sessionToken })
}

export async function DELETE(req: NextRequest) {
  let body: { sessionToken?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!body.sessionToken) {
    return NextResponse.json({ error: 'sessionToken required' }, { status: 400 })
  }
  await revokeSession(body.sessionToken)
  return NextResponse.json({ ok: true })
}
