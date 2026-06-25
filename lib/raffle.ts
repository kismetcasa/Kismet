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
 *   <base>:winner      STR   the admin-chosen winner (lowercased)
 *   <base>:state       STR   'open' | 'closed'
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

/** Member form for the cross-moment RAFFLE_ENABLED_KEY zset. */
const enabledMember = (c: string, t: string) => `${norm(c)}:${t}`

export type RaffleState = 'open' | 'closed'

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
  return s === 'closed' ? 'closed' : 'open'
}

export async function setRaffleState(
  collection: string,
  tokenId: string,
  state: RaffleState,
): Promise<void> {
  await redis.set(stateKey(collection, tokenId), state)
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

/** Admin action: set the winner and close entries in one step. */
export async function setWinner(
  collection: string,
  tokenId: string,
  address: string,
): Promise<void> {
  await redis.set(winnerKey(collection, tokenId), norm(address))
  await setRaffleState(collection, tokenId, 'closed')
}

/** Admin action: clear the winner and reopen entries (re-pick). */
export async function clearWinner(
  collection: string,
  tokenId: string,
): Promise<void> {
  await redis.del(winnerKey(collection, tokenId))
  await setRaffleState(collection, tokenId, 'open')
}
