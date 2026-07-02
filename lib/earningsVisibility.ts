import { redis } from './redis'
import { memoize } from './memoCache'
import { getFidByAddress, getVerifiedAddressesByFid } from './farcasterProfile'

// Per-artist "earnings public" opt-in — the gate for the public earnings
// surfaces (profile card, share card). One SET of opted-in identities;
// earnings stay private until the artist pins them.
//
// MEMBER FORMS. An FC user's pin is keyed by IDENTITY (`fid:<n>`), not by
// address: their canonical address changes over time (identity switches via
// /api/me/identity, web-first anchor drift, the profile PUT's upsertFidProfile
// path), and an address-keyed pin silently flipped their earnings back to
// private on every such change — a whole class of per-route migrations this
// keying removes. Non-FC users pin by lowercase address (their address IS
// their identity). Address members written before the FID keying shipped
// remain readable as legacy pins: the read checks the FID form first, then
// the queried address, then the FC siblings (a legacy pin lives under
// whichever canonical made it); writes migrate them to the FID form lazily.
//
// The set is memoized (mirrors hidden-users) so the per-request check costs
// ~0 Redis: one SMEMBERS per TTL per pod, not per profile view. A toggle
// invalidates the own-pod cache immediately; other pods reflect it within
// the TTL.
//
// FAILURE POLICY. Reads degrade: a transient FC failure resolves to "address
// members only", so an FC user's pin may read private for the 30s transient-
// cache window — never public-by-mistake. Writes FAIL CLOSED: setEarningsPublic
// THROWS when the identity can't be resolved (getFidByAddress → null) or an FC
// user's verifications read comes back empty (an FC identity always carries at
// least its linked address; empty = transient failure). Degrading a WRITE
// instead once unpinned only the address member while the fid:<n> member
// survived — earnings stayed publicly pinned after an explicit hide. The
// toggle route maps the throw to a retryable error and the card reverts its
// optimistic state.
//
// ACCEPTED EDGE: a pin keyed fid:<n> becomes unreachable if the user later
// deactivates Farcaster / unverifies every address (reads resolve fid=null →
// private). If they then re-verify to the same FID, the old pin resurfaces
// unless they toggled while FC-linked in between (any toggle clears the fid
// form). Deactivation cycles are rare enough that we prefer this to keeping a
// second, address-keyed source of truth around.
const KEY_EARNINGS_PUBLIC = 'kismetart:stats-public'
const fidMember = (fid: number) => `fid:${fid}`

async function _getPublicEarners(): Promise<Set<string>> {
  try {
    const members = (await redis.smembers(KEY_EARNINGS_PUBLIC)) as string[]
    return new Set(members.map((a) => a.toLowerCase()))
  } catch {
    return new Set()
  }
}
const getPublicEarners = memoize(_getPublicEarners, 60_000)

export interface EarningsVisibilityIdentity {
  /** Canonical (or queried) address. */
  address: string
  /** FID when the caller already resolved it (e.g. resolveCanonicalProfile);
   *  null = known non-FC; undefined = resolve here via the cached FC lookup. */
  fid?: number | null
}

export async function isEarningsPublic(
  identity: string | EarningsVisibilityIdentity,
): Promise<boolean> {
  const { address, fid: knownFid } =
    typeof identity === 'string' ? { address: identity, fid: undefined } : identity
  const lower = address.toLowerCase()
  const members = await getPublicEarners()
  // Fast path: non-FC pin or legacy address pin under the queried address —
  // no identity resolution needed.
  if (members.has(lower)) return true
  const fid =
    knownFid !== undefined ? knownFid : ((await getFidByAddress(lower))?.fid ?? null)
  if (fid == null) return false
  if (members.has(fidMember(fid))) return true
  // Legacy address pin that lives under a SIBLING: the canonical address that
  // pinned it (pre-FID-keying) may differ from today's canonical. One
  // Redis-cached verifications read.
  const siblings = await getVerifiedAddressesByFid(fid)
  return siblings.some((s) => members.has(s))
}

/**
 * Toggle the pin. THROWS when the identity is transiently unresolvable (see
 * the failure policy above) — the caller must surface a retryable error, not
 * a false success over a half-applied write.
 */
export async function setEarningsPublic(address: string, isPublic: boolean): Promise<void> {
  const lower = address.toLowerCase()
  const lookup = await getFidByAddress(lower)
  if (lookup === null) {
    throw new Error('earnings-visibility: identity lookup unavailable, retry')
  }
  const fid = lookup.fid
  if (fid == null) {
    if (isPublic) await redis.sadd(KEY_EARNINGS_PUBLIC, lower)
    else await redis.srem(KEY_EARNINGS_PUBLIC, lower)
  } else {
    // FC user: the FID form is the pin. Either direction also clears any
    // legacy address members across the verification set, so a later unpin
    // can't be shadowed by a stale sibling pin from before the FID keying.
    // An FC identity always carries its linked address as a verification, so
    // an empty list is a transient read failure — fail closed rather than
    // sweep partially.
    const siblings = await getVerifiedAddressesByFid(fid)
    if (siblings.length === 0) {
      throw new Error('earnings-visibility: verifications unavailable, retry')
    }
    const legacy = Array.from(new Set([lower, ...siblings]))
    if (isPublic) {
      await redis
        .multi()
        .sadd(KEY_EARNINGS_PUBLIC, fidMember(fid))
        .srem(KEY_EARNINGS_PUBLIC, legacy[0], ...legacy.slice(1))
        .exec()
    } else {
      await redis.srem(KEY_EARNINGS_PUBLIC, fidMember(fid), ...legacy)
    }
  }
  getPublicEarners.invalidate()
}
