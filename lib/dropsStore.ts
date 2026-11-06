import 'server-only'
import type { Address, Hex } from 'viem'
import { memoize, type Memoized } from './memoCache'
import { redis } from './redis'
import { isArkivConfigured } from './arkiv/client'
import { getDrop, listClaims, listOpenDrops, listSettlingDrops } from './arkiv/drops'
import { LRUCache } from './lruCache'
import type { ClaimView, DropRecord, DropView } from './drops'

/**
 * The parts of claim drops that must NOT live on Arkiv: who uploaded which
 * Swarm file, the atomic one-claim-per-wallet + cap check, and short caches
 * of Arkiv reads. Arkiv has no conditional write (no "create only if fewer
 * than N exist", no uniqueness constraint), so two claims racing for the last
 * slot would both land; Redis's single-threaded Lua is the arbiter, and Arkiv
 * is the public record of what it admitted. See arkiv/why-arkiv.md.
 */

/** Off unless DROPS_ENABLED=1 and an Arkiv writer is configured. A kill
 *  switch needs no flag of its own: the platform pause
 *  (lib/gate.isPlatformPausedFor) already stops the upload, open and claim
 *  routes. */
export function isDropsEnabled(): boolean {
  return process.env.DROPS_ENABLED?.trim() === '1' && isArkivConfigured()
}

// ── Swarm uploads ────────────────────────────────────────────────────────

const MEDIA_TTL_SECONDS = 2 * 24 * 60 * 60
const mediaKey = (ref: string) => `kismetart:drops:media:${ref}`

/** Mark a Swarm reference as uploaded through /api/drops/media (type-sniffed,
 *  size-capped, Pass-gated), so a drop can only be opened on such a file —
 *  never on an arbitrary reference — within two days of the upload. */
export async function markUploaded(ref: string): Promise<void> {
  await redis.set(mediaKey(ref), '1', { ex: MEDIA_TTL_SECONDS })
}

export async function wasUploaded(ref: string): Promise<boolean> {
  return (await redis.exists(mediaKey(ref))) === 1
}

// ── Claim reservations ───────────────────────────────────────────────────

const claimsKey = (dropKey: Hex) => `kismetart:drops:claims:${dropKey.toLowerCase()}`

// SADD + cap check in one script: returns the new count, -1 when this
// wallet already holds a slot, -2 when the drop is full (and undoes the add).
// EXPIREAT at the drop's close: once claims are closed the set has no use.
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

export async function reserveClaim(
  dropKey: Hex,
  collector: Address,
  maxClaims: number,
  closesAt: number,
): Promise<'reserved' | 'duplicate' | 'full'> {
  const n = Number(await redis.eval(RESERVE_LUA, [claimsKey(dropKey)], [collector.toLowerCase(), maxClaims, closesAt]))
  if (n === -1) return 'duplicate'
  if (n === -2) return 'full'
  return 'reserved'
}

/** Give a slot back — the Arkiv write behind it failed, so the wallet can retry. */
export async function releaseClaim(dropKey: Hex, collector: Address): Promise<void> {
  await redis.srem(claimsKey(dropKey), collector.toLowerCase())
}

// ── Arkiv read caches ────────────────────────────────────────────────────
//
// Every Arkiv RPC call spends the access key's monthly quota
// (docs.arkiv.network/start-here/access-keys). The drop page polls while a
// drop is open and the feed costs one count query per card, so both are
// cached briefly and shared by every viewer: a popular drop costs one read
// per CACHE_MS however many people watch it. Single container, so a
// process-local cache is the whole cache.

const CACHE_MS = 10_000

/** A drop entity is readonly, so its terms never change: cached for good
 *  (bounded), one getEntity for a burst of claims or artwork requests. */
const recordCache = new LRUCache<string, DropRecord>(500)

export async function getDropRecord(dropKey: Hex): Promise<DropRecord | null> {
  const cached = recordCache.get(dropKey)
  if (cached) return cached
  const drop = await getDrop(dropKey)
  if (drop) recordCache.set(dropKey, drop)
  return drop
}

const feed = memoize(async () => {
  const nowSec = Math.floor(Date.now() / 1000)
  const [open, settling] = await Promise.all([listOpenDrops(nowSec), listSettlingDrops(nowSec)])
  return { open, settling }
}, CACHE_MS)

export function getDropsFeed(): Promise<{ open: DropView[]; settling: DropView[] }> {
  return feed()
}

export interface DropDetail {
  drop: DropRecord
  claims: ClaimView[]
}

const details = new LRUCache<string, Memoized<DropDetail | null>>(500)

export function getDropDetail(dropKey: Hex): Promise<DropDetail | null> {
  let memo = details.get(dropKey)
  if (!memo) {
    memo = memoize(async () => {
      const drop = await getDropRecord(dropKey)
      return drop ? { drop, claims: await listClaims(dropKey) } : null
    }, CACHE_MS)
    details.set(dropKey, memo)
  }
  return memo()
}

/** After a claim lands, the next read must show it — the claimer's page
 *  reloads right away and would otherwise offer "Claim" again. */
export function invalidateDropReads(dropKey: Hex): void {
  details.get(dropKey)?.invalidate()
  feed.invalidate()
}
