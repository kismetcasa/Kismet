import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { upsertProfile, upsertFidProfile, getFidProfile, getProfile, consumeNonce } from '@/lib/profile'
import { expandToFidSiblings, isProfileIdentityHidden, resolveCanonicalProfile } from '@/lib/addressUnion'
import { getSessionAddress } from '@/lib/session'
import { getFarcasterProfileByAddress, getVerifiedAddressesByFid } from '@/lib/farcasterProfile'
import { getCachedEns, resolveEnsAndCache } from '@/lib/ensCache'
import { pickProfileIdentity } from '@/lib/profileIdentity'
import { errorResponse } from '@/lib/apiResponse'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'
import { getArtistEarnings } from '@/lib/stats'
import { isEarningsPublic } from '@/lib/earningsVisibility'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  if (!isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }
  // ENS, FC profile, and canonical-profile resolution are all
  // independent + I/O-bound. Fan them out so the slowest call (the
  // FC API, ~50-200ms cold) sets total latency rather than their sum.
  //
  // resolveCanonicalProfile returns the right profile across all
  // three identity models — FID-keyed, address-keyed, or sibling-
  // inherited — along with the canonical address for URL redirects.
  // See lib/addressUnion.ts for the precedence rules.
  const [canonical, farcaster, cachedEns] = await Promise.all([
    resolveCanonicalProfile(address),
    getFarcasterProfileByAddress(address),
    getCachedEns(address),
  ])
  const { profile, canonicalAddress } = canonical
  // Admin-hidden profile → 404 for everyone but the owner (any of their
  // FID-sibling wallets, via session cookie or Farcaster bearer). The
  // owner keeps API access so their own profile page — which the SSR
  // gate still renders for them — hydrates normally. 404 rather than 403
  // so hidden state isn't distinguishable from a nonexistent profile.
  if (await isProfileIdentityHidden(address, canonicalAddress)) {
    const viewer = await getSessionAddress(req)
    const isOwner =
      !!viewer &&
      (await expandToFidSiblings(canonicalAddress)).some(
        (s) => s.toLowerCase() === viewer.toLowerCase(),
      )
    if (!isOwner) return errorResponse(404, 'Profile not found')
  }
  // Public earnings ride along on the profile read so the earnings card needs no
  // separate request (earnings are private until pinned; the owner-private
  // figures come from /api/stats only when an owner views their own unpinned
  // profile). Passing the already-resolved fid skips the visibility check's
  // internal FC lookup. Memoized set read here, +reads only when public.
  const earnings = (await isEarningsPublic({ address: canonicalAddress, fid: canonical.fid }))
    ? await getArtistEarnings(canonicalAddress)
    : null
  if (!profile.username && cachedEns === undefined) {
    after(() => resolveEnsAndCache(address))
  }
  // Server-side enrichment so existing components auto-propagate FC
  // identity without per-component changes:
  //   - avatarUrl: prefer the user's own Kismet upload; fall back to FC pfp
  //   - displayName: collapses the username/farcaster/ens fallback chain
  //     into a single field so callers don't have to repeat the precedence
  //     logic at every render site
  //   - canonicalAddress: the address whose profile this data lives
  //     under. Differs from the queried address when (a) the queried
  //     address is a sibling that inherited from another verification,
  //     or (b) the FidProfile.currentAddress doesn't match. Clients
  //     can use it to canonicalize their URL.
  const ensName = cachedEns || undefined
  // Shared projection (same one /api/profiles uses) so the single + batch
  // routes can't diverge on identity resolution. displayName keeps its
  // nullable contract: '' (nothing resolved) collapses to null as before.
  const { name, avatarUrl } = pickProfileIdentity(profile, farcaster, cachedEns)
  const displayName = name || null
  return NextResponse.json({
    profile: {
      ...profile,
      avatarUrl,
      ensName,
      displayName,
      canonicalAddress,
      farcaster: farcaster ?? undefined,
      earnings,
    },
  })
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params
  if (!isAddress(address)) {
    return errorResponse(400, 'Invalid address')
  }

  let body: { username?: string; avatarUrl?: string; signature?: string; nonce?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  if (!body.signature || !body.nonce) {
    return errorResponse(400, 'signature and nonce required')
  }

  // avatarUrl is rendered server-side via next/og <img src> in the profile
  // OG-image route (ImageResponse fetches it during PNG render). A bare
  // https:// prefix check let an attacker store an internal URL
  // (https://169.254.169.254/…, https://localhost:port/…) and exfiltrate the
  // fetched bytes through the generated share card — validate the host, not
  // just the scheme.
  if (body.avatarUrl && !isSafePublicHttpsUrl(body.avatarUrl)) {
    return errorResponse(400, 'avatarUrl must be a public https URL')
  }

  // Verify the signature proves ownership of the address
  const message = `Update Kismet profile\nAddress: ${address.toLowerCase()}\nNonce: ${body.nonce}`
  const verified = await verifyMessage({
    address: address as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })

  if (!verified) {
    return errorResponse(401, 'Signature verification failed')
  }

  // Consume the nonce only after signature is confirmed valid
  const valid = await consumeNonce(address, body.nonce)
  if (!valid) {
    return errorResponse(401, 'Invalid or expired nonce')
  }

  const username = body.username?.trim().slice(0, 30) || undefined

  // Route the write to the right store based on the user's identity
  // model. Signature already proved ownership of `address`, so we
  // only write to stores where `address` is the legitimate target:
  //
  //   * FC user with FidProfile → FID-keyed. Updates username/avatar
  //     but preserves currentAddress; identity-switching is a
  //     separate /api/me/identity action.
  //   * FC user with no FidProfile but existing data at some verified
  //     address (web-first) → address-keyed at the anchor. If the
  //     URL doesn't match the anchor, reject with the canonical URL
  //     so the client can redirect (avoids silently fragmenting data
  //     across two addresses for the same FID).
  //   * FC user with no profile data anywhere (miniapp-first first
  //     edit) → create FidProfile with currentAddress = this address.
  //   * No FC → address-keyed as today.
  const fcProfile = await getFarcasterProfileByAddress(address)
  let profile
  if (!fcProfile) {
    profile = await upsertProfile(address, { username, avatarUrl: body.avatarUrl })
  } else {
    const fid = fcProfile.fid
    const existingFid = await getFidProfile(fid)
    if (existingFid) {
      const updated = await upsertFidProfile(fid, existingFid.currentAddress, {
        username,
        avatarUrl: body.avatarUrl,
      })
      profile = {
        address: updated.currentAddress,
        username: updated.username,
        avatarUrl: updated.avatarUrl,
        updatedAt: updated.updatedAt,
      }
    } else {
      const verifications = await getVerifiedAddressesByFid(fid)
      let anchor: string | null = null
      for (const v of verifications) {
        const existing = await getProfile(v)
        if (existing.username || existing.avatarUrl) {
          anchor = v
          break
        }
      }
      if (anchor) {
        if (anchor !== address.toLowerCase()) {
          return NextResponse.json(
            { error: 'Update at canonical address', canonicalAddress: anchor },
            { status: 409 },
          )
        }
        profile = await upsertProfile(address, { username, avatarUrl: body.avatarUrl })
      } else {
        const updated = await upsertFidProfile(fid, address, {
          username,
          avatarUrl: body.avatarUrl,
        })
        profile = {
          address: updated.currentAddress,
          username: updated.username,
          avatarUrl: updated.avatarUrl,
          updatedAt: updated.updatedAt,
        }
      }
    }
  }
  return NextResponse.json({ profile })
}
