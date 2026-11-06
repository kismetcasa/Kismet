import 'server-only'
import type { Address, Hex } from 'viem'
import { isFlagSet } from './gateFlags'
import { memoize } from './memoCache'
import { redis, DROPS_ENABLED_KEY } from './redis'
import { isArkivReadable } from './arkiv/client'
import { getDrop } from './arkiv/drops'
import { LRUCache } from './lruCache'
import type { DropView } from './drops'

/**
 * The parts of claim drops that must NOT live on Arkiv: the feature flag,
 * who uploaded which Swarm file, and the atomic one-claim-per-wallet + cap
 * check. Arkiv has no conditional write (no "create only if fewer than N
 * exist", no uniqueness constraint), so two claims racing for the last slot
 * would both land; Redis's single-threaded Lua is the arbiter, and Arkiv is
 * the public record of what it admitted. See arkiv/why-arkiv.md ("what we
 * kept off Arkiv") and arkiv/friction.md.
 */

// ── Feature flag ─────────────────────────────────────────────────────────

const _isFlagOn = memoize(async () => isFlagSet(await redis.get<string | number | null>(DROPS_ENABLED_KEY)), 60_000)

/** On when Arkiv is configured AND (DROPS_ENABLED=1 or the admin flag). */
export async function isDropsEnabled(): Promise<boolean> {
  if (!isArkivReadable()) return false
  if (process.env.DROPS_ENABLED?.trim() === '1') return true
  try {
    return await _isFlagOn()
  } catch {
    return false
  }
}

/** Raw admin flag (no env override) — for the admin route's report. */
export async function readDropsFlag(): Promise<boolean> {
  return _isFlagOn()
}

export async function setDropsFlag(enabled: boolean): Promise<void> {
  if (enabled) await redis.set(DROPS_ENABLED_KEY, '1')
  else await redis.del(DROPS_ENABLED_KEY)
  _isFlagOn.invalidate()
}

// ── Swarm uploads ────────────────────────────────────────────────────────

const MEDIA_TTL_SECONDS = 2 * 24 * 60 * 60
const mediaKey = (ref: string) => `kismetart:drops:media:${ref}`

/** Remember who uploaded a Swarm file, so a drop can only be opened on
 *  artwork its own artist uploaded through Kismet. */
export async function recordMediaUploader(ref: string, uploader: string): Promise<void> {
  await redis.set(mediaKey(ref), uploader.toLowerCase(), { ex: MEDIA_TTL_SECONDS })
}

export async function getMediaUploader(ref: string): Promise<string | null> {
  const v = await redis.get<string | null>(mediaKey(ref))
  return typeof v === 'string' ? v.toLowerCase() : null
}

// ── Claim reservations ───────────────────────────────────────────────────

const claimsKey = (dropKey: Hex) => `kismetart:drops:claims:${dropKey.toLowerCase()}`

// SADD + cap check in one script: returns the new count, -1 when this
// wallet already holds a slot, -2 when the drop is full (and undoes the add).
// EXPIREAT ties the set's life to the drop record's, so nothing lingers.
const RESERVE_LUA = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
if added == 0 then return -1 end
local n = redis.call('SCARD', KEYS[1])
if n > tonumber(ARGV[2]) then
  redis.call('SREM', KEYS[1], ARGV[1])
  return -2
end
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return n
`

export type ReserveResult = 'reserved' | 'duplicate' | 'full'

export async function reserveClaim(
  dropKey: Hex,
  collector: Address,
  maxClaims: number,
  expireAtSec: number,
): Promise<ReserveResult> {
  const n = Number(
    await redis.eval(RESERVE_LUA, [claimsKey(dropKey)], [collector.toLowerCase(), maxClaims, expireAtSec]),
  )
  if (n === -1) return 'duplicate'
  if (n === -2) return 'full'
  return 'reserved'
}

/** Give a slot back — the Arkiv write behind it failed, so the wallet can retry. */
export async function releaseClaim(dropKey: Hex, collector: Address): Promise<void> {
  await redis.srem(claimsKey(dropKey), collector.toLowerCase())
}

// ── Drop terms cache ─────────────────────────────────────────────────────

// A drop entity is readonly, so its terms (artist, close time, cap) can never
// change: once read, they are good until the entity expires. The claim route
// reads them on every claim; this keeps a burst of claims to one getEntity.
// Claim counts are NOT cached here — they change, and come from Arkiv.
export type DropTerms = Pick<DropView, 'key' | 'artist' | 'closesAt' | 'maxClaims' | 'swarmRef' | 'mime'>

const termsCache = new LRUCache<string, DropTerms>(500)

export async function getDropTerms(dropKey: Hex): Promise<DropTerms | null> {
  const cached = termsCache.get(dropKey.toLowerCase())
  if (cached) return cached
  const drop = await getDrop(dropKey)
  if (!drop) return null
  const terms: DropTerms = {
    key: drop.key,
    artist: drop.artist,
    closesAt: drop.closesAt,
    maxClaims: drop.maxClaims,
    swarmRef: drop.swarmRef,
    mime: drop.mime,
  }
  termsCache.set(dropKey.toLowerCase(), terms)
  return terms
}
