import 'server-only'
import { redis } from './redis'
import { serverBaseClient } from './rpc'

/**
 * Off-chain Patron raffle store. A raffle is identified by (collection,
 * tokenId) — the Patron edition collectors hold. Entering is recorded here in
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
 */

const PREFIX = 'kismetart:raffle'
const norm = (s: string) => s.toLowerCase()
const base = (collection: string, tokenId: string) =>
  `${PREFIX}:${norm(collection)}:${tokenId}`
const entrantsKey = (c: string, t: string) => `${base(c, t)}:entrants`
const enteredAtKey = (c: string, t: string) => `${base(c, t)}:entered-at`
const winnerKey = (c: string, t: string) => `${base(c, t)}:winner`
const stateKey = (c: string, t: string) => `${base(c, t)}:state`

export type RaffleState = 'open' | 'closed'

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
