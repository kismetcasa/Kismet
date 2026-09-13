/**
 * Grants that turn-off could not revoke, awaiting retry.
 *
 * Turning the agent off deletes the record and revokes every live permission to
 * KISMET's spender (revokeAsSpender, no user signature). If that revoke fails or
 * outlives the request's time budget, the record is already gone — so the
 * per-record `supersededPermissions` queue can't hold the grant. It lands here
 * instead and is retried with the spender in hand (post-response on the run
 * route, and at the end of a drop coordination). A grant the chain reports as
 * revoked/expired drops out on the next drain, so a user-signed revoke that
 * landed meanwhile is harmless. Grants never expire on their own (they are
 * created without an `end`), which is why nothing here is ever silently dropped.
 *
 * Layout — one HASH per owner keyed by the grant's identity (permKey), plus a
 * SET of owners as the index — so that no path ever rewrites another owner's
 * entries, queuing is a single atomic HSET, a drain retires only the exact keys
 * it revoked (a grant queued mid-drain survives), and a read failure can never
 * turn into a destructive write. The index entry is dropped only by a Lua step
 * that checks the hash is empty in the same command, so an HSET+SADD landing
 * concurrently cannot leave an indexed-nowhere grant.
 */

import { redis } from '@/lib/redis'
import { permKey, revokePermissionsAsSpender } from './revoke'
import type { StoredSpendPermission } from './serverExecutor'
import type { ScoutSpender } from './spender'

const INDEX = 'kismetart:scout-pending-revoke:owners'
const ownerKey = (owner: string) => `kismetart:scout-pending-revoke:${owner.toLowerCase()}`
// "Forget this owner only if nothing is queued" — atomic, so it cannot race a
// concurrent queue (HSET + SADD in one transaction below).
const UNINDEX_IF_EMPTY = "if redis.call('HLEN', KEYS[1]) == 0 then return redis.call('SREM', KEYS[2], ARGV[1]) end return 0"

/** Remember grants to retry. Idempotent per grant (keyed by permKey). */
export async function queuePendingRevokes(owner: string, perms: readonly StoredSpendPermission[]): Promise<void> {
  if (perms.length === 0) return
  const o = owner.toLowerCase()
  const fields: Record<string, string> = {}
  for (const p of perms) fields[permKey(p)] = JSON.stringify(p)
  await redis.multi().hset(ownerKey(o), fields).sadd(INDEX, o).exec()
}

/** A grant the user has re-adopted as their live permission (the config route
 *  stored it again) must not be revoked by a later drain: forget it. */
export async function dequeuePendingRevoke(owner: string, perm: StoredSpendPermission): Promise<void> {
  const o = owner.toLowerCase()
  await redis.hdel(ownerKey(o), permKey(perm))
  await redis.eval(UNINDEX_IF_EMPTY, [ownerKey(o), INDEX], [o])
}

function parsePerm(v: unknown): StoredSpendPermission | null {
  try {
    return (typeof v === 'string' ? JSON.parse(v) : v) as StoredSpendPermission
  } catch {
    return null
  }
}

/**
 * Retry queued revokes with the spender in hand. Bounded per call (a few owners,
 * picked at random so one owner whose entries keep failing cannot starve the
 * rest), best-effort per owner. Retires exactly the keys it revoked.
 */
export async function drainPendingRevokes(spender: ScoutSpender, maxOwners = 3): Promise<void> {
  const owners = ((await redis.smembers(INDEX)) as string[]).map((o) => o.toLowerCase())
  if (owners.length === 0) return
  for (let i = owners.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[owners[i], owners[j]] = [owners[j], owners[i]]
  }
  for (const o of owners.slice(0, maxOwners)) {
    try {
      const raw = (await redis.hgetall<Record<string, unknown>>(ownerKey(o))) ?? {}
      const entries = Object.entries(raw)
        .map(([k, v]) => [k, parsePerm(v)] as const)
        .filter((e): e is readonly [string, StoredSpendPermission] => e[1] !== null)
      if (entries.length > 0) {
        const failed = new Set((await revokePermissionsAsSpender(entries.map(([, p]) => p), spender)).map(permKey))
        const retired = entries.filter(([k]) => !failed.has(k)).map(([k]) => k)
        if (retired.length > 0) await redis.hdel(ownerKey(o), ...retired)
      }
      await redis.eval(UNINDEX_IF_EMPTY, [ownerKey(o), INDEX], [o])
    } catch (err) {
      console.error('[scout] pending-revoke drain failed for an owner', { owner: o, err: err instanceof Error ? err.message : String(err) })
    }
  }
}
