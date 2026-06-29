import 'server-only'
import { redis, RAFFLE_ENABLED_KEY } from './redis'
import { serverBaseClient } from './rpc'

/**
 * Off-chain raffle store. A raffle is identified by (collection, tokenId) — the
 * edition collectors hold. An admin enables a raffle PER MOMENT (see
 * RAFFLE_ENABLED_KEY + /api/raffle/enabled); entering is then recorded here in
 * Redis (verified server-side: the entrant signed, and holds the edition
 * on-chain); the winner is chosen MANUALLY by an admin (no on-chain
 * randomness). "Announce only" — nothing is burned, the winner just keeps
 * their edition and is notified; physical fulfilment happens off-platform.
 *
 * Keys (kismetart: prefix, matching lib/redis + lib/pass-validity conventions):
 *   <base>:entrants    SET   lowercased entrant addresses
 *   <base>:entered-at  HASH  addr -> unix seconds (audit / ordering)
 *   <base>:winner          STR   the drawn winner (lowercased)
 *   <base>:state           STR   'open' | 'ended'
 *   <base>:entries-close-at STR  unix seconds entries auto-close at (optional)
 * plus the cross-moment RAFFLE_ENABLED_KEY zset of `<addr>:<tokenId>` (which
 * mints have a raffle at all). Enablement is independent of entrant/winner
 * data, so disabling then re-enabling a moment preserves its entrants.
 */

const PREFIX = 'kismetart:raffle'
const norm = (s: string) => s.toLowerCase()
const base = (collection: string, tokenId: string) =>
  `${PREFIX}:${norm(collection)}:${tokenId}`
const entrantsKey = (c: string, t: string) => `${base(c, t)}:entrants`
const enteredAtKey = (c: string, t: string) => `${base(c, t)}:entered-at`
const winnerKey = (c: string, t: string) => `${base(c, t)}:winner`
const stateKey = (c: string, t: string) => `${base(c, t)}:state`
// Unix seconds at which entries auto-close (snapshotted from the moment's sale
// end at enable time; editable). Absent → entries never auto-close.
const entriesCloseAtKey = (c: string, t: string) => `${base(c, t)}:entries-close-at`

/** Member form for the cross-moment RAFFLE_ENABLED_KEY zset. */
const enabledMember = (c: string, t: string) => `${norm(c)}:${t}`

// 'open'  — live; entries accepted until entriesCloseAt passes.
// 'ended' — finalized; winner (if any) recorded, non-winners released to "list".
export type RaffleState = 'open' | 'ended'

export interface EnabledRaffle {
  collectionAddress: string
  tokenId: string
  enabledAt: number
}

/** Is a raffle enabled for this (collection, tokenId)? Source of truth for
 *  whether the "enter raffle" affordance shows at all. */
export async function isRaffleEnabled(
  collection: string,
  tokenId: string,
): Promise<boolean> {
  const score = await redis.zscore(RAFFLE_ENABLED_KEY, enabledMember(collection, tokenId))
  return score != null
}

/** Admin action: enable the raffle for one moment. Idempotent (re-stamps the
 *  enabled-at score). Does NOT touch entrants/winner/state — re-enabling a
 *  previously-disabled raffle restores its entrants as they were. */
export async function setRaffleEnabled(
  collection: string,
  tokenId: string,
): Promise<void> {
  await redis.zadd(RAFFLE_ENABLED_KEY, {
    score: Date.now(),
    member: enabledMember(collection, tokenId),
  })
}

/** Admin action: disable the raffle for one moment. Leaves entrant/winner data
 *  intact so it can be re-enabled without loss. */
export async function clearRaffleEnabled(
  collection: string,
  tokenId: string,
): Promise<void> {
  await redis.zrem(RAFFLE_ENABLED_KEY, enabledMember(collection, tokenId))
}

/** All raffle-enabled moments, newest first. Powers the public GET that the
 *  client loads once on mount (AdminContext.raffleEnabledKeys). */
export async function getEnabledRaffles(): Promise<EnabledRaffle[]> {
  const raw = (await redis.zrange(RAFFLE_ENABLED_KEY, 0, -1, {
    rev: true,
    withScores: true,
  })) as (string | number)[]
  const out: EnabledRaffle[] = []
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const member = String(raw[i])
    const colon = member.indexOf(':')
    if (colon <= 0) continue
    out.push({
      collectionAddress: member.slice(0, colon),
      tokenId: member.slice(colon + 1),
      enabledAt: Number(raw[i + 1]),
    })
  }
  return out
}

export interface RaffleEntrant {
  address: string
  enteredAt: number | null
}

const BALANCE_OF_ABI = [
  {
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

const BALANCE_OF_BATCH_ABI = [
  {
    inputs: [{ type: 'address[]' }, { type: 'uint256[]' }],
    name: 'balanceOfBatch',
    outputs: [{ type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

/** Live on-chain check: does `address` hold ≥1 of (collection, tokenId)?
 *  Provenance-agnostic (raw balanceOf, NOT hasValidPass) — the raffle only
 *  cares that you own the edition, however you acquired it. Fails closed. */
export async function holdsEdition(
  collection: string,
  tokenId: string,
  address: string,
): Promise<boolean> {
  try {
    const bal = (await serverBaseClient().readContract({
      address: collection as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [address as `0x${string}`, BigInt(tokenId)],
    })) as bigint
    return bal > 0n
  } catch {
    return false
  }
}

/** One-RPC balanceOfBatch for the admin entrants list (≤100 entrants). Maps
 *  lowercased address -> currently-holds. Fails closed (all false) on error. */
export async function holdsEditionBatch(
  collection: string,
  tokenId: string,
  addresses: string[],
): Promise<Record<string, boolean>> {
  if (addresses.length === 0) return {}
  try {
    const balances = (await serverBaseClient().readContract({
      address: collection as `0x${string}`,
      abi: BALANCE_OF_BATCH_ABI,
      functionName: 'balanceOfBatch',
      args: [
        addresses.map((a) => a as `0x${string}`),
        addresses.map(() => BigInt(tokenId)),
      ],
    })) as readonly bigint[]
    const out: Record<string, boolean> = {}
    addresses.forEach((a, i) => {
      out[norm(a)] = (balances[i] ?? 0n) > 0n
    })
    return out
  } catch {
    return Object.fromEntries(addresses.map((a) => [norm(a), false]))
  }
}

export async function getRaffleState(
  collection: string,
  tokenId: string,
): Promise<RaffleState> {
  const s = await redis.get<string>(stateKey(collection, tokenId))
  // 'closed' is the legacy terminal value (the old setWinner wrote it); treat it
  // as 'ended' so any pre-migration finalized raffle still reads as concluded
  // (winner shown, non-winners released) without a data migration.
  return s === 'ended' || s === 'closed' ? 'ended' : 'open'
}

export async function setRaffleState(
  collection: string,
  tokenId: string,
  state: RaffleState,
): Promise<void> {
  await redis.set(stateKey(collection, tokenId), state)
}

/** Unix seconds entries auto-close at, or null if none set. */
export async function getEntriesCloseAt(
  collection: string,
  tokenId: string,
): Promise<number | null> {
  const v = await redis.get<number | string>(entriesCloseAtKey(collection, tokenId))
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Set (or clear, with null) the entries auto-close time. */
export async function setEntriesCloseAt(
  collection: string,
  tokenId: string,
  closeAt: number | null,
): Promise<void> {
  if (closeAt == null) {
    await redis.del(entriesCloseAtKey(collection, tokenId))
  } else {
    await redis.set(entriesCloseAtKey(collection, tokenId), Math.floor(closeAt))
  }
}

/** Are entries currently being accepted? False once ended or the close time
 *  has passed. (Enablement is checked separately via isRaffleEnabled.) */
export async function entriesOpen(
  collection: string,
  tokenId: string,
): Promise<boolean> {
  if ((await getRaffleState(collection, tokenId)) === 'ended') return false
  const closeAt = await getEntriesCloseAt(collection, tokenId)
  if (closeAt == null) return true
  return Math.floor(Date.now() / 1000) < closeAt
}

export async function isEntered(
  collection: string,
  tokenId: string,
  address: string,
): Promise<boolean> {
  return !!(await redis.sismember(entrantsKey(collection, tokenId), norm(address)))
}

/** Record an entry. Idempotent (SADD dedupes); stamps first-seen time. */
export async function addEntry(
  collection: string,
  tokenId: string,
  address: string,
): Promise<void> {
  const a = norm(address)
  await redis.sadd(entrantsKey(collection, tokenId), a)
  await redis.hset(enteredAtKey(collection, tokenId), {
    [a]: Math.floor(Date.now() / 1000),
  })
}

export async function getEntrantCount(
  collection: string,
  tokenId: string,
): Promise<number> {
  return (await redis.scard(entrantsKey(collection, tokenId))) ?? 0
}

export async function getEntrants(
  collection: string,
  tokenId: string,
): Promise<RaffleEntrant[]> {
  const members = ((await redis.smembers(entrantsKey(collection, tokenId))) ??
    []) as string[]
  const times =
    ((await redis.hgetall(enteredAtKey(collection, tokenId))) as Record<
      string,
      string | number
    > | null) ?? {}
  return members
    .map((address) => ({
      address,
      enteredAt: times[address] != null ? Number(times[address]) : null,
    }))
    .sort((a, b) => (a.enteredAt ?? 0) - (b.enteredAt ?? 0))
}

export async function getWinner(
  collection: string,
  tokenId: string,
): Promise<string | null> {
  return (await redis.get<string>(winnerKey(collection, tokenId))) ?? null
}

/**
 * Eligible entrants: those who STILL hold the edition (entered-then-sold are
 * ineligible to win). One batched on-chain read; preserves entry order.
 */
export async function getEligibleEntrants(
  collection: string,
  tokenId: string,
): Promise<RaffleEntrant[]> {
  const entrants = await getEntrants(collection, tokenId)
  if (entrants.length === 0) return []
  const holding = await holdsEditionBatch(
    collection,
    tokenId,
    entrants.map((e) => e.address),
  )
  return entrants.filter((e) => holding[norm(e.address)])
}

/**
 * Finalize the raffle: record the winner (if any) and mark it ended. Non-winners
 * are released back to "list"; the winner sees "you won". Entrants are kept, so
 * a reopen can restore the live state.
 */
export async function endRaffle(
  collection: string,
  tokenId: string,
  winner: string | null,
): Promise<void> {
  if (winner) {
    await redis.set(winnerKey(collection, tokenId), norm(winner))
  } else {
    await redis.del(winnerKey(collection, tokenId))
  }
  await setRaffleState(collection, tokenId, 'ended')
}

/** Un-end: clear the winner and reopen entries (recover from a mistaken draw). */
export async function reopenRaffle(
  collection: string,
  tokenId: string,
): Promise<void> {
  await redis.del(winnerKey(collection, tokenId))
  await setRaffleState(collection, tokenId, 'open')
}
