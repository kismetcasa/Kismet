import type { Profile } from './profile'
import type { FarcasterProfile } from './farcasterProfile'

// Single source of truth for collapsing a resolved profile + farcaster + ENS
// into the { name, avatarUrl } a UI row shows. Used by BOTH
// /api/profile/[address] (the full single-profile route) and /api/profiles
// (the lite batch route) so the two can never diverge on how an address
// resolves to a display identity.
//
// Precedence (unchanged from the original single-route formula):
//   name   = own username → farcaster username → ENS name → '' (caller shows shortAddress)
//   avatar = own upload    → farcaster pfp      → undefined
export function pickProfileIdentity(
  profile: Pick<Profile, 'username' | 'avatarUrl'>,
  farcaster: Pick<FarcasterProfile, 'username' | 'pfpUrl'> | null | undefined,
  ens: string | null | undefined,
): { name: string; avatarUrl: string | undefined } {
  return {
    name: profile.username || farcaster?.username || ens || '',
    avatarUrl: profile.avatarUrl || farcaster?.pfpUrl || undefined,
  }
}
