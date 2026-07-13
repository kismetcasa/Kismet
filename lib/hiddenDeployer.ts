import { getHiddenIdentityClosure } from './addressUnion'

// A collection's deployer handle — the inprocess `creator` / `default_admin`
// username — is seeded UNGATED into the collection header, collection cards,
// and share cards. Those components keep the inprocess seed instead of the
// gated profile resolution (their `fetchCreatorProfile` override is skipped
// whenever a seed is present), so a hidden identity's @handle PERSISTS there —
// unlike the profile page / feeds, which the hide-profile feature already
// gates. There is no single choke point (each surface fetches inprocess
// independently), so this helper is applied at every inprocess-collection
// egress point to null the deployer username when that identity is admin-
// hidden. The address is preserved: the gated client resolver still renders a
// display name for NON-hidden deployers, and a hidden one falls back to
// shortAddress like every other surface.
//
// FAIL OPEN: on a hidden-set Redis error we leave the data untouched rather
// than throw. This is a display-only path dropped into surfaces with differing
// error handling (SSR page, OG image, hot list endpoints); the profile-page
// gate remains the fail-closed authority, and a brief handle flash during a
// Redis outage is an acceptable degrade. NO-OP fast paths keep the common case
// cheap: no deployer fields → return before any Redis read; nothing hidden →
// one memoized set read then return the input unchanged; something hidden but
// not THIS deployer → return the input by reference (no copy), which avoids
// re-allocating every unchanged row on the discovery feed that runs this
// per collection.
type MaybeDeployer = { address?: string; username?: string | null } | null | undefined

function gate<I extends MaybeDeployer>(identity: I, closure: Set<string>): I {
  if (
    identity &&
    identity.address &&
    identity.username != null &&
    closure.has(identity.address.toLowerCase())
  ) {
    return { ...identity, username: null }
  }
  return identity
}

export async function stripHiddenDeployerIdentity<T>(data: T): Promise<T> {
  const d = data as { creator?: MaybeDeployer; default_admin?: MaybeDeployer } | null | undefined
  if (!d || (d.creator == null && d.default_admin == null)) return data
  let closure: Set<string>
  try {
    closure = await getHiddenIdentityClosure()
  } catch {
    return data
  }
  if (closure.size === 0) return data
  const creator = gate(d.creator, closure)
  const default_admin = gate(d.default_admin, closure)
  if (creator === d.creator && default_admin === d.default_admin) return data
  return { ...(data as object), creator, default_admin } as T
}
