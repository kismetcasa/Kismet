import 'server-only'
import { isProfileIdentityHidden, resolveCanonicalProfile } from './addressUnion'
import { getCachedEns } from './ensCache'
import { shortAddress } from './inprocess'
import { pickProfileIdentity } from './profileIdentity'

/**
 * The name to print for an address where no client can resolve it — a share
 * card, page metadata: the platform's one standard (Kismet username, then
 * Farcaster username, then ENS, as /api/profile's pickProfileIdentity), the
 * short address otherwise. An admin-hidden identity prints as its address,
 * as on every profile surface. Never throws.
 */
export async function displayNameFor(address: string): Promise<string> {
  try {
    if (await isProfileIdentityHidden(address)) return shortAddress(address)
    const [{ profile, farcaster }, ens] = await Promise.all([resolveCanonicalProfile(address), getCachedEns(address)])
    return pickProfileIdentity(profile, farcaster, ens).name || shortAddress(address)
  } catch {
    return shortAddress(address)
  }
}
