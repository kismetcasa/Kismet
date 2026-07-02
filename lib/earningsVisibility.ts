import { redis } from './redis'
import { memoize } from './memoCache'
import { getFarcasterProfileByAddress, getVerifiedAddressesByFid } from './farcasterProfile'

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
// the TTL. FC resolution on the read path uses the Redis-cached FC lookups
// (warm on every profile view) — a transient FC failure degrades to
// "address members only", i.e. an FC user's pin may read private for the
// 30s transient-cache window, never public-by-mistake.
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
    knownFid !== undefined
      ? knownFid
      : ((await getFarcasterProfileByAddress(lower))?.fid ?? null)
  if (fid == null) return false
  if (members.has(fidMember(fid))) return true
  // Legacy address pin that lives under a SIBLING: the canonical address that
  // pinned it (pre-FID-keying) may differ from today's canonical. One
  // Redis-cached verifications read.
  const siblings = await getVerifiedAddressesByFid(fid)
  return siblings.some((s) => members.has(s))
}

export async function setEarningsPublic(address: string, isPublic: boolean): Promise<void> {
  const lower = address.toLowerCase()
  const fid = (await getFarcasterProfileByAddress(lower))?.fid ?? null
  if (fid == null) {
    if (isPublic) await redis.sadd(KEY_EARNINGS_PUBLIC, lower)
    else await redis.srem(KEY_EARNINGS_PUBLIC, lower)
  } else {
    // FC user: the FID form is the pin. Either direction also clears any
    // legacy address members across the verification set, so a later unpin
    // can't be shadowed by a stale sibling pin from before the FID keying.
    const siblings = await getVerifiedAddressesByFid(fid)
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
