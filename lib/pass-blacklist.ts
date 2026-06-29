import { redis } from './redis'
import { memoize } from './memoCache'
import { ADMIN_ADDRESS } from './config'

/**
 * Pass-specific blacklist. Distinct from lib/blacklist (the action
 * blacklist that blocks mint/write/list/airdrop entry points) — this
 * one denies Pass validity to the listed addresses even when they hold
 * a Pass NFT on-chain.
 *
 * Wired into:
 *   - hasValidPass()    — short-circuit to false before consulting the
 *                         ledger or running on-chain reconciliation.
 *   - processTransfer() — when the recipient (`to`) of a Transfer is on
 *                         the list, skip the credit step even on a
 *                         platform-originated tx. (`from` is still
 *                         decremented — if a blacklisted holder sends
 *                         the Pass elsewhere, that's a legit decrement.)
 *
 * Use case: revoke creator access from a holder after acquisition
 * (sanctions, grift, cohort quality control) while the platform still
 * acknowledges they own the Pass on-chain. setValidBalance(addr, 0)
 * alone is insufficient — the next legit Transfer event would increment
 * them back to a positive balance, and they'd silently regain access.
 *
 * Admin is hardcoded-exempt at both read and write so an accidental
 * self-listing can't lock the platform out of its own administration.
 * Fails open on Redis error so a transient outage doesn't accidentally
 * deny every Pass holder (the action layer above this is the gate
 * itself, which fails closed on RPC/Redis errors — defense lives there).
 */

const KEY = 'kismetart:pass-blacklist'

// Full-set cache — same pattern as lib/blacklist.ts / lib/hidden-users.ts.
// Converts one SISMEMBER per hasValidPass call into one SMEMBERS per
// 15-minute window per process. Fails open so a Redis outage doesn't deny
// every Pass holder; admin is always exempt regardless.
async function _getPassBlacklistSet(): Promise<Set<string>> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return new Set(addrs.map((a) => a.toLowerCase()))
  } catch {
    return new Set()
  }
}
// 15-min memo: add/remove invalidate immediately, so the longer TTL only trims
// redundant SMEMBERS of an unchanged set (single instance → free saving).
const getPassBlacklistSet = memoize(_getPassBlacklistSet, 15 * 60_000)

export async function isPassBlacklisted(
  address: string | null | undefined,
): Promise<boolean> {
  if (!address) return false
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) return false
  const set = await getPassBlacklistSet()
  return set.has(lower)
}

export async function addToPassBlacklist(address: string): Promise<void> {
  const lower = address.toLowerCase()
  if (ADMIN_ADDRESS && lower === ADMIN_ADDRESS) {
    throw new Error('Cannot pass-blacklist the admin address')
  }
  await redis.sadd(KEY, lower)
  getPassBlacklistSet.invalidate()
}

export async function removeFromPassBlacklist(address: string): Promise<void> {
  await redis.srem(KEY, address.toLowerCase())
  getPassBlacklistSet.invalidate()
}

export async function listPassBlacklist(): Promise<string[]> {
  try {
    const addrs = (await redis.smembers(KEY)) as string[]
    return Array.isArray(addrs) ? addrs.sort() : []
  } catch {
    return []
  }
}
