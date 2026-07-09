import { cache } from 'react'
import {
  getFarcasterProfileByAddress,
  getVerifiedAddressesByFid,
  type FarcasterProfile,
} from './farcasterProfile'
import { getCachedSmartWallets } from './smartWalletCache'
import { getFidProfile, getProfile, type FidProfile, type Profile } from './profile'

/**
 * Expand an Ethereum address into the set of all addresses controlled by
 * the same Farcaster identity.
 *
 *   - Non-FC address          → `[input]`
 *   - FC-verified address     → `[input, ...siblings]` (all verified
 *                                addresses of the same FID, lowercased,
 *                                deduped, input always first)
 *
 * Used by activity feeds (`/api/timeline`'s creator/collector filters)
 * so a user's mints, collects, etc. surface on the profile page of any
 * of their verified wallets — not just the one the activity was signed
 * from. This is the server-side "address union" that makes a Farcaster
 * user feel like a single Kismet identity regardless of which of their
 * wallets they happen to use for a given on-chain action.
 *
 * Both lookups are Redis-cached (see lib/farcasterProfile.ts) so this
 * runs ≈1 cache read for an unfound FC user, ≈2 for an FC user. Cold
 * cache cost is one FC API call each.
 */
export async function expandToFidSiblings(address: string): Promise<string[]> {
  const lower = address.toLowerCase()
  const profile = await getFarcasterProfileByAddress(lower)
  if (!profile) return [lower]

  const siblings = await getVerifiedAddressesByFid(profile.fid)
  // Set preserves uniqueness; spreading [lower, ...siblings] keeps the
  // original address at the front for any caller that cares about
  // ordering (e.g. logs that surface the "queried" address first).
  return Array.from(new Set<string>([lower, ...siblings]))
}

/**
 * The wallets an artist's EARNINGS can legitimately live under: their FC
 * sibling set PLUS each sibling's inprocess per-creator smart wallet.
 *
 * The smart wallets matter because In•Process executes Kismet mints as the
 * per-creator smart wallet (the on-chain msg.sender), and its feeds often
 * attribute the mint to that contract address (see the creator-resolution
 * comment in MomentDetailView). A contract can never be an FC verification,
 * so the plain sibling union reads 0 for anything credited to it — the
 * "artist with real sales sees an empty earnings card" failure. Stats reads
 * (getArtistEarnings / getArtistPending) union over THIS set; identity-facing
 * callers (timeline filters, profile resolution) keep using
 * expandToFidSiblings — a smart wallet is a payment alias, not an identity.
 *
 * Cost: ONE Redis MGET on top of expandToFidSiblings, regardless of sibling
 * count (Upstash bills per command, and this runs on the visitor-hot public
 * profile path). Missing cache entries just mean that sibling's smart wallet
 * isn't unioned yet — same degraded-but-correct behavior as before this
 * helper existed.
 */
export async function expandToEarningsWallets(address: string): Promise<string[]> {
  const siblings = await expandToFidSiblings(address)
  const smartWallets = await getCachedSmartWallets(siblings)
  const all = new Set<string>(siblings)
  for (const sw of smartWallets) {
    if (sw) all.add(sw.toLowerCase())
  }
  return Array.from(all)
}

export interface ResolvedProfile {
  /** Effective profile (may have inherited username/avatar from a sibling). */
  profile: Profile
  /** FC profile for the queried address, if it's FC-verified. */
  farcaster: FarcasterProfile | null
  /** True when username or avatarUrl came from a sibling rather than the queried address. */
  inheritedFromSibling: boolean
}

/**
 * Resolve a profile that may have been created on a sibling FC address.
 *
 * When the queried address has no Kismet profile of its own but a
 * sibling verified to the same FID does (e.g. the user created their
 * profile from address 0xB and is now visiting the page for their FC
 * primary 0xA), surface the sibling's username + avatarUrl so the
 * FC-verified user looks the same regardless of which wallet they
 * happen to have created their Kismet profile from.
 *
 * Local-profile-wins: if the queried address has its own username, it's
 * preferred over any sibling's. Same for avatarUrl. Sibling values only
 * fill in fields the queried address left blank.
 *
 * All sub-lookups are Redis-cached so the worst case is one cold FC
 * verifications fetch plus N Redis reads (N = sibling count, usually 1-3).
 */
export type CanonicalSource = 'fid' | 'address' | 'sibling' | 'empty'

export interface CanonicalProfile {
  /** Effective profile data (from whichever store holds it). */
  profile: Profile
  /** Address the data actually lives under — for URL canonicalization. */
  canonicalAddress: string
  /** FID if the queried address is FC-verified; null otherwise. */
  fid: number | null
  /** FC profile for the queried address (username, displayName, pfpUrl),
   *  surfaced for generateMetadata callers so they don't have to re-fetch. */
  farcaster: FarcasterProfile | null
  /** Where the data came from — drives WalletsPanel rendering + redirect logic. */
  source: CanonicalSource
  /** Raw FID record when source === 'fid'; needed by /api/me to expose
   *  currentAddress and identity-switching state to the client. */
  fidProfile?: FidProfile
}

/**
 * Resolve the canonical profile for an arbitrary address across the
 * three identity models Kismet supports:
 *
 *   - **No FC** (pure web user): address-keyed profile, canonical = self.
 *   - **FC + miniapp-first** (FidProfile exists): FID-keyed profile,
 *     canonical = FidProfile.currentAddress. /profile/{any-verification}
 *     redirects to this currentAddress.
 *   - **FC + web-first** (address-keyed profile at some verification,
 *     no FidProfile): address-keyed profile at the anchor sibling,
 *     canonical = that anchor. Today's resolveProfileWithSiblings
 *     behavior preserved.
 *
 * Used by /api/profile/[address] (GET) for read + canonical-URL hints,
 * /api/me for the current identity address, and the share-card path
 * that needs to know whose profile we're rendering.
 *
 * Wrapped in React.cache so generateMetadata + the page render share a
 * single resolution (Next.js calls both within one request lifecycle).
 * Without this they'd each fire ~4 Redis lookups + the FC-by-address
 * fetch — same keys, so cheap on the second pass, but the cache
 * primitive removes the double-call entirely.
 */
export const resolveCanonicalProfile = cache(async (
  address: string,
): Promise<CanonicalProfile> => {
  const lower = address.toLowerCase()
  const fcProfile = await getFarcasterProfileByAddress(lower)

  // Non-FC user — address-based, canonical = self.
  if (!fcProfile) {
    const profile = await getProfile(lower)
    return {
      profile,
      canonicalAddress: lower,
      fid: null,
      farcaster: null,
      source: profile.username || profile.avatarUrl ? 'address' : 'empty',
    }
  }

  // FC user. FidProfile wins if it exists (miniapp-first path).
  const fidProfile = await getFidProfile(fcProfile.fid)
  if (fidProfile) {
    return {
      profile: {
        address: fidProfile.currentAddress,
        username: fidProfile.username,
        avatarUrl: fidProfile.avatarUrl,
        updatedAt: fidProfile.updatedAt,
      },
      canonicalAddress: fidProfile.currentAddress,
      fid: fcProfile.fid,
      farcaster: fcProfile,
      source: 'fid',
      fidProfile,
    }
  }

  // FC user, no FidProfile yet (web-first or freshly-connected FC).
  // Fall through to address + sibling resolution. Canonical address
  // is whichever sibling actually holds the data.
  const sibLink = await resolveProfileWithSiblings(lower)
  let canonicalAddress = lower
  if (sibLink.inheritedFromSibling) {
    const siblings = await getVerifiedAddressesByFid(fcProfile.fid)
    const others = await Promise.all(siblings.filter((a) => a !== lower).map(getProfile))
    const owner = others
      .filter((p) => p.username || p.avatarUrl)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (owner) canonicalAddress = owner.address
  }
  const hasData = sibLink.profile.username || sibLink.profile.avatarUrl
  return {
    profile: sibLink.profile,
    canonicalAddress,
    fid: fcProfile.fid,
    farcaster: fcProfile,
    source: hasData ? (sibLink.inheritedFromSibling ? 'sibling' : 'address') : 'empty',
  }
})

export async function resolveProfileWithSiblings(
  address: string,
): Promise<ResolvedProfile> {
  const lower = address.toLowerCase()
  const [profile, farcaster] = await Promise.all([
    getProfile(lower),
    getFarcasterProfileByAddress(lower),
  ])

  // Non-FC address, or queried address already has a username — no
  // sibling lookup needed.
  if (!farcaster || profile.username) {
    return { profile, farcaster, inheritedFromSibling: false }
  }

  const siblings = await getVerifiedAddressesByFid(farcaster.fid)
  const others = siblings.filter((a) => a !== lower)
  if (others.length === 0) {
    return { profile, farcaster, inheritedFromSibling: false }
  }

  const siblingProfiles = await Promise.all(others.map(getProfile))
  // Only consider siblings that actually have something worth
  // inheriting — a username or an uploaded avatar.
  const candidates = siblingProfiles
    .filter((p) => (p.username && p.username.trim()) || p.avatarUrl)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  if (candidates.length === 0) {
    return { profile, farcaster, inheritedFromSibling: false }
  }
  const best = candidates[0]
  return {
    profile: {
      ...profile,
      username: profile.username || best.username,
      avatarUrl: profile.avatarUrl || best.avatarUrl,
    },
    farcaster,
    inheritedFromSibling: true,
  }
}
