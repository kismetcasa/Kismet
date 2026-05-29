import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { verifyFarcasterJwt, setKismetIdentityAddress } from '@/lib/farcasterAuth'
import { getVerifiedAddressesByFid } from '@/lib/farcasterProfile'
import {
  getFidProfile,
  getProfile,
  setFidCurrentAddress,
  upsertFidProfile,
} from '@/lib/profile'
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
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Require a Bearer JWT (Mini App). Cookie-auth (web) is intentionally
  // not accepted here — the wallet picker doesn't apply to web users.
  const auth = req.headers.get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return errorResponse(401, 'Sign in via Farcaster to continue')
  }
  const token = auth.slice('Bearer '.length).trim()
  if (!token) return errorResponse(401, 'Missing token')
  const session = await verifyFarcasterJwt(token)
  if (!session) return errorResponse(401, 'Invalid token')

  let body: { address?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  const target = body.address
  if (!target || !isAddress(target)) {
    return errorResponse(400, 'Invalid address')
  }
  const lower = target.toLowerCase()

  // Membership check — picked address must be verified to this FID on
  // Farcaster. Without this gate a user could route their Kismet
  // identity at any address (impersonation).
  const verifications = await getVerifiedAddressesByFid(session.fid)
  if (!verifications.includes(lower)) {
    return errorResponse(403, 'Address is not verified to this Farcaster account')
  }

  // FidProfile.currentAddress is the new source of truth for identity
  // routing. Update precedence below + the legacy pointer for back-
  // compat during the deprecation window. Three cases:
  //
  //   * FidProfile exists → just move the pointer. No data change.
  //   * No FidProfile but address-based profile at some verification
  //     (web-first user choosing to switch for the first time) → copy
  //     username/avatar into a new FidProfile keyed by `lower`. The
  //     old address record stays in KV so the user can switch back
  //     to it cleanly via WalletsPanel (we'd just move currentAddress
  //     back; data lives in the FidProfile from now on).
  //   * No profile data anywhere → create empty FidProfile with
  //     currentAddress = lower (miniapp-first user picking a wallet
  //     before they've added a username).
  const existing = await getFidProfile(session.fid)
  if (existing) {
    await setFidCurrentAddress(session.fid, lower)
  } else {
    // Reuse `verifications` from the membership check above instead of
    // re-fetching — same list, same request lifetime.
    let anchorProfile = null
    for (const v of verifications) {
      const candidate = await getProfile(v)
      if (candidate.username || candidate.avatarUrl) {
        anchorProfile = candidate
        break
      }
    }
    await upsertFidProfile(session.fid, lower, {
      username: anchorProfile?.username,
      avatarUrl: anchorProfile?.avatarUrl,
    })
  }
  // Legacy pointer kept in lock-step so getKismetIdentityAddress's
  // fallback path (for callers that haven't migrated) sees the same
  // value. Cheap; safe to drop once we're confident no caller reads
  // the legacy key directly.
  await setKismetIdentityAddress(session.fid, lower)
  return NextResponse.json(
    { address: lower },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
