import { NextRequest, NextResponse, after } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { upsertProfile, upsertFidProfile, getFidProfile, getProfile, consumeNonce, type Profile } from '@/lib/profile'
import { isProfileIdentityHidden, isViewerFidSibling, resolveCanonicalProfile } from '@/lib/addressUnion'
import { getSessionAddress } from '@/lib/session'
import { getFarcasterProfileByAddress, getVerifiedAddressesByFid, getVerifiedTwitterByFid } from '@/lib/farcasterProfile'
import { getCachedEns, resolveEnsAndCache } from '@/lib/ensCache'
import { pickProfileIdentity } from '@/lib/profileIdentity'
import { errorResponse } from '@/lib/apiResponse'
import { isSafePublicHttpsUrl } from '@/lib/safeUrl'
import { normalizeSocials, type ProfileSocials } from '@/lib/socials'
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
  // Admin-hidden profile → non-owners get the EMPTY-PROFILE STUB a wallet
  // that never touched Kismet gets (200, no username/avatar, no FC/ENS
  // enrichment, canonicalAddress = the queried address so sibling links
  // don't leak). NOT a 404: this route never 404s any other valid address
  // (profiles are wallet-keyed), so a 404 here would be a public oracle
  // uniquely fingerprinting "admin-hidden" — returning the natural void
  // state makes hidden indistinguishable from unused. The owner (any
  // FID-sibling wallet, via session cookie or Farcaster bearer) still gets
  // the full payload so their own profile page hydrates normally.
  if (await isProfileIdentityHidden(address, canonicalAddress)) {
    const viewer = await getSessionAddress(req)
    if (!(await isViewerFidSibling(viewer, canonicalAddress))) {
      const lower = address.toLowerCase()
      return NextResponse.json({
        profile: {
          address: lower,
          updatedAt: 0,
          displayName: null,
          canonicalAddress: lower,
          earnings: null,
        },
      })
    }
  }
  // Public earnings ride along on the profile read so the earnings card needs no
  // separate request (earnings are private until pinned; the owner-private
  // figures come from /api/stats only when an owner views their own unpinned
  // profile). Passing the already-resolved fid skips the visibility check's
  // internal FC lookup. Memoized set read here, +reads only when public.
  //
  // fcWallets: the identity's FC-verified sibling wallets (public data on
  // Farcaster; the canonical 307 redirect already implies the linkage). The
  // client-side owner check needs it: on web there is no FC identity context,
  // so after the canonical redirect an owner connected with a non-canonical
  // sibling wallet was rendered the VISITOR view of their own profile —
  // including a silently absent earnings card.
  //
  // Shipped ONLY when the identity actually UNIFIES under this canonical —
  // a FidProfile exists, or an anchor profile holds data — because that is
  // when authorizeProfileOwner resolves every sibling's session to this
  // address. For a data-less FC identity ('empty') each sibling canonicalizes
  // to ITSELF, so a sibling-keyed client owner check would render owner UI
  // whose every server call 403s; omitting the field keeps those viewers on
  // the visitor view, exactly as before this field existed. (Accepted edge:
  // two data-bearing web-first anchors on one FID can still diverge — rare,
  // and bounded to error toasts on writes.)
  //
  // Redis-cached (1h) and passed into isEarningsPublic as its pre-resolved
  // sibling list, so the unpinned default path pays the SAME single
  // verifications read it always did — the payload field adds no command.
  const identityUnifies =
    canonical.fid != null &&
    (canonical.source === 'fid' || !!profile.username || !!profile.avatarUrl)
  // fcWallets + the verified-X handle are both canonical.fid reads and
  // independent, so fetch them together (both Redis-cached, ~1h).
  const [fcWallets, verifiedTwitter] = await Promise.all([
    identityUnifies && canonical.fid != null
      ? getVerifiedAddressesByFid(canonical.fid)
      : Promise.resolve<string[]>([]),
    canonical.fid != null
      ? getVerifiedTwitterByFid(canonical.fid)
      : Promise.resolve<string | null>(null),
  ])
  const earnings = (await isEarningsPublic({
    address: canonicalAddress,
    fid: canonical.fid,
    siblings: fcWallets.length ? fcWallets : undefined,
  }))
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
  // Proof-of-ownership socials inherited from Farcaster. Only X is verifiable
  // on FC today; when present it outranks any manually-claimed `x` and the
  // client renders it with a verified badge. `...profile` already carries the
  // user's own (unverified) `socials`.
  const verifiedSocials = verifiedTwitter ? { x: verifiedTwitter } : undefined
  return NextResponse.json({
    profile: {
      ...profile,
      avatarUrl,
      ensName,
      displayName,
      canonicalAddress,
      farcaster: farcaster ?? undefined,
      earnings,
      ...(fcWallets.length ? { fcWallets } : {}),
      ...(verifiedSocials ? { verifiedSocials } : {}),
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

  let body: { username?: string; avatarUrl?: string; socials?: unknown; signature?: string; nonce?: string }
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

  // Only touch socials when the client actually sent the key (older callers
  // that PUT just username/avatar must not wipe stored links). Handles are
  // stored bare and normalized; website is host-guarded like avatarUrl.
  let socials: ProfileSocials | undefined
  if (body.socials !== undefined) {
    const res = normalizeSocials(body.socials)
    if ('error' in res) return errorResponse(400, res.error)
    socials = res.socials
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
  const writeData: Partial<Pick<Profile, 'username' | 'avatarUrl' | 'socials'>> = {
    username,
    avatarUrl: body.avatarUrl,
  }
  if (socials !== undefined) writeData.socials = socials

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
    profile = await upsertProfile(address, writeData)
  } else {
    const fid = fcProfile.fid
    const existingFid = await getFidProfile(fid)
    if (existingFid) {
      const updated = await upsertFidProfile(fid, existingFid.currentAddress, writeData)
      profile = {
        address: updated.currentAddress,
        username: updated.username,
        avatarUrl: updated.avatarUrl,
        socials: updated.socials,
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
        profile = await upsertProfile(address, writeData)
      } else {
        const updated = await upsertFidProfile(fid, address, writeData)
        profile = {
          address: updated.currentAddress,
          username: updated.username,
          avatarUrl: updated.avatarUrl,
          socials: updated.socials,
          updatedAt: updated.updatedAt,
        }
      }
    }
  }
  return NextResponse.json({ profile })
}
