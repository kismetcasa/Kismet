import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { verifyFarcasterJwt, setKismetIdentityAddress } from '@/lib/farcasterAuth'
import { getVerifiedAddressesByFid } from '@/lib/farcasterProfile'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

// POST /api/me/identity   { address }
//
// Set the user's chosen Kismet identity address — which of their
// FC-verified wallets is the "public face" of their Kismet profile
// (drives display name, profile URL, share cards, etc.).
//
// Auth: Quick Auth Bearer JWT. NOT the session cookie — this endpoint
// is Mini-App-only. Web users have a single connected wallet and don't
// need a chooser.
//
// Validation: the picked address MUST be in the user's FC-verifications
// list. We don't trust the client to enforce this — a malicious caller
// could otherwise set their "identity" to any address.
//
// Side-effect on success: a subsequent /api/me will return the new
// chosen address, and every authenticated server endpoint scopes to
// it. No signature required from the user — FC verification already
// proved ownership of the picked address.
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`me-identity:${ip}`, 20, 60)
  if (!allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
  }

  // Require a Bearer JWT (Mini App). Cookie-auth (web) is intentionally
  // not accepted here — the wallet picker doesn't apply to web users.
  const auth = req.headers.get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return NextResponse.json(
      { error: 'Sign in via Farcaster to continue' },
      { status: 401 },
    )
  }
  const token = auth.slice('Bearer '.length).trim()
  if (!token) {
    return NextResponse.json({ error: 'Missing token' }, { status: 401 })
  }
  const session = await verifyFarcasterJwt(token)
  if (!session) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  let body: { address?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  const target = body.address
  if (!target || !isAddress(target)) {
    return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
  }
  const lower = target.toLowerCase()

  // Membership check — picked address must be verified to this FID on
  // Farcaster. Without this gate a user could route their Kismet
  // identity at any address (impersonation).
  const verifications = await getVerifiedAddressesByFid(session.fid)
  if (!verifications.includes(lower)) {
    return NextResponse.json(
      { error: 'Address is not verified to this Farcaster account' },
      { status: 403 },
    )
  }

  await setKismetIdentityAddress(session.fid, lower)
  return NextResponse.json(
    { address: lower },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
