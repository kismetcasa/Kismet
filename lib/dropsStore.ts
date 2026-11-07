import 'server-only'
import type { Address, Hex } from 'viem'
import { memoize, type Memoized } from './memoCache'
import { redis } from './redis'
import { acquireLock, type RedisLock } from './redisLock'
import { isArkivConfigured } from './arkiv/client'
import { getDrop, getSettlements, listClaims, listClaimsOwnedBy, listOpenDrops, listSettlingDrops } from './arkiv/drops'
import { LRUCache } from './lruCache'
import { recordExpiresAt, type ClaimView, type DropRecord, type DropView, type SettlementView } from './drops'

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
const fidsKey = (dropKey: Hex) => `kismetart:drops:fids:${dropKey.toLowerCase()}`

// One claim per wallet AND, when the claim comes with a Farcaster identity
// (Quick Auth in the Mini App), one per Farcaster account — a person with
// several wallets on one account gets one claim. Checked and written in one
// script: returns the new count, -1 when the wallet already holds a slot, -3
// when the Farcaster account does (through another wallet), -2 when the drop
// is full — nothing is written then. EXPIREAT at the drop's close: once
// claims are closed the sets have no use.
const RESERVE_LUA = `
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return -1 end
if ARGV[2] ~= '' and redis.call('SISMEMBER', KEYS[2], ARGV[2]) == 1 then return -3 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[3]) then return -2 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIREAT', KEYS[1], ARGV[4])
if ARGV[2] ~= '' then
  redis.call('SADD', KEYS[2], ARGV[2])
  redis.call('EXPIREAT', KEYS[2], ARGV[4])
end
return redis.call('SCARD', KEYS[1])
`

export async function reserveClaim(
  dropKey: Hex,
  collector: Address,
  fid: number | null,
  maxClaims: number,
  closesAt: number,
): Promise<'reserved' | 'duplicate' | 'account-claimed' | 'full'> {
  const n = Number(
    await redis.eval(RESERVE_LUA, [claimsKey(dropKey), fidsKey(dropKey)], [collector.toLowerCase(), fid ? String(fid) : '', maxClaims, closesAt]),
  )
  if (n === -1) return 'duplicate'
  if (n === -3) return 'account-claimed'
  if (n === -2) return 'full'
  return 'reserved'
}

/** Give a slot back — the Arkiv write behind it failed, so the wallet can retry. */
export async function releaseClaim(dropKey: Hex, collector: Address, fid: number | null): Promise<void> {
  await redis.srem(claimsKey(dropKey), collector.toLowerCase())
  if (fid) await redis.srem(fidsKey(dropKey), String(fid))
}

// ── Settlement progress ──────────────────────────────────────────────────
//
// Settling is two signatures (mint the edition, then airdrop it), and the
// artist can leave in between. What happened so far is kept per drop until
// the drop's records expire, so they resume rather than re-upload or mint a
// second edition: `body` is the prepared mint (its artwork already on
// Arweave), `recipients` the snapshot it was sized to, and `minted` the new
// token once the relay answered.

export interface SettleProgress {
  body: Record<string, unknown>
  recipients: string[]
  /** `fromBlock`: Base's head just before the mint was sent — the airdrop
   *  can only land after it (where …/settle looks for it on resume). */
  minted?: { collection: string; tokenId: string; fromBlock: string }
}

const settleKey = (dropKey: Hex) => `kismetart:drops:settle:${dropKey.toLowerCase()}`

export async function getSettleProgress(dropKey: Hex): Promise<SettleProgress | null> {
  const v = await redis.get<SettleProgress | string | null>(settleKey(dropKey))
  if (!v) return null
  return typeof v === 'string' ? (JSON.parse(v) as SettleProgress) : v
}

export async function setSettleProgress(dropKey: Hex, closesAt: number, progress: SettleProgress): Promise<void> {
  await redis.set(settleKey(dropKey), JSON.stringify(progress), { exat: recordExpiresAt(closesAt) })
}

export async function clearSettleProgress(dropKey: Hex): Promise<void> {
  await redis.del(settleKey(dropKey))
}

// One settle step at a time per drop: a double click must not mint two
// editions or record two settlements. The relay can take a while (an
// auto-deploy plus the mint); the lock outlives any realistic answer, frees
// itself if the process dies mid-step, and is released by token (lib/redisLock)
// so a step that outlived it can't free a successor's.
const SETTLE_LOCK_SECONDS = 180

export function lockSettle(dropKey: Hex): Promise<RedisLock> {
  return acquireLock(`kismetart:drops:settle-lock:${dropKey.toLowerCase()}`, SETTLE_LOCK_SECONDS)
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
  const settled = await getSettlements(settling.map((d) => d.key))
  return { open, settling: settling.map((d) => ({ ...d, delivered: settled.has(d.key) })) }
}, CACHE_MS)

export function getDropsFeed(): Promise<{ open: DropView[]; settling: DropView[] }> {
  return feed()
}

export interface DropDetail {
  drop: DropRecord
  claims: ClaimView[]
  settlement: SettlementView | null
}

const details = new LRUCache<string, Memoized<DropDetail | null>>(500)

export function getDropDetail(dropKey: Hex): Promise<DropDetail | null> {
  let memo = details.get(dropKey)
  if (!memo) {
    memo = memoize(async () => {
      const drop = await getDropRecord(dropKey)
      if (!drop) return null
      const [claims, settlements] = await Promise.all([listClaims(dropKey), getSettlements([dropKey])])
      return { drop, claims, settlement: settlements.get(dropKey) ?? null }
    }, CACHE_MS)
    details.set(dropKey, memo)
  }
  return memo()
}

/** A wallet's claims with where each drop stands — the collector's view
 *  (GET /api/drops/claims). Claims are entities the wallet OWNS (`ownedBy`),
 *  so a claim handed to it counts and one handed away doesn't; each drop's
 *  terms come from the record cache. A drop whose records expired has taken
 *  its claims with it, so nothing dangles. */
export interface OwnedClaim {
  claimKey: string
  dropKey: string
  title: string
  artist: string
  closesAt: number
  claimedAt: number
  settlement: SettlementView | null
}

const owned = new LRUCache<string, Memoized<OwnedClaim[]>>(500)

export function getClaimsOf(owner: Address): Promise<OwnedClaim[]> {
  const k = owner.toLowerCase()
  let memo = owned.get(k)
  if (!memo) {
    memo = memoize(async () => {
      const claims = await listClaimsOwnedBy(owner)
      const drops = await Promise.all(claims.map((c) => getDropRecord(c.drop).catch(() => null)))
      const settled = await getSettlements([...new Set(claims.map((c) => c.drop))])
      return claims.flatMap((c, i) => {
        const d = drops[i]
        if (!d) return []
        return [{
          claimKey: c.key,
          dropKey: d.key,
          title: d.title,
          artist: d.artist,
          closesAt: d.closesAt,
          claimedAt: c.claimedAt,
          settlement: settled.get(d.key) ?? null,
        }]
      })
    }, CACHE_MS)
    owned.set(k, memo)
  }
  return memo()
}

/** After a claim lands, the next read must show it — the claimer's page
 *  reloads right away and would otherwise offer "Claim" again. */
export function invalidateDropReads(dropKey: Hex, claimer?: Address): void {
  details.get(dropKey)?.invalidate()
  feed.invalidate()
  if (claimer) owned.get(claimer.toLowerCase())?.invalidate()
}
