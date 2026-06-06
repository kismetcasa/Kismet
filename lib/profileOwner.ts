import type { NextRequest } from 'next/server'
import { getSessionAddress } from './session'
import { resolveCanonicalProfile } from './addressUnion'

// Shared owner gate for canonical-keyed profile resources (pins, theme).
// Session cookie / FC JWT auth + canonical-address match, so any of an FC
// user's verified wallets edits the one profile. Returns the canonical address
// on success, or an { error, status } the caller maps to a response. Single
// source of truth so the owner contract can't drift between routes.
export async function authorizeProfileOwner(
  req: NextRequest,
  pathAddress: string,
): Promise<{ canonical: string } | { error: string; status: number }> {
  const session = await getSessionAddress(req)
  if (!session) return { error: 'Sign in to continue', status: 401 }
  const [sessionCanon, pathCanon] = await Promise.all([
    resolveCanonicalProfile(session),
    resolveCanonicalProfile(pathAddress),
  ])
  if (sessionCanon.canonicalAddress.toLowerCase() !== pathCanon.canonicalAddress.toLowerCase()) {
    return { error: 'You can only edit your own profile', status: 403 }
  }
  return { canonical: pathCanon.canonicalAddress }
}
