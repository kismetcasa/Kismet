import {
  getFarcasterProfileByAddress,
  getVerifiedAddressesByFid,
  type FarcasterProfile,
} from './farcasterProfile'
import { getProfile, type Profile } from './profile'

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
