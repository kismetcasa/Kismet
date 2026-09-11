/**
 * Grants that turn-off could not revoke, awaiting retry.
 *
 * Turning the agent off deletes the record and revokes every live permission to
 * KISMET's spender (revokeAsSpender, no user signature). If that revoke fails or
 * outlives the request's time budget, the record is already gone — so the
 * per-record `supersededPermissions` queue can't hold the grant. It lands here
 * instead, keyed by owner, and is retried post-response on later runs (the run
 * route, where the spender is already in hand). A grant the chain reports as
 * revoked/expired drops out on the next drain, so a user-signed revoke that
 * landed meanwhile is harmless. Grants never expire on their own (they are
 * created without an `end`), which is why nothing here is ever silently dropped.
 *
 * One JSON document under one key: turn-offs are rare and the queue is tiny,
 * and a plain GET/SET keeps it readable in any Redis (and the verify harness).
 */

import { redis } from '@/lib/redis'
import { permKey, revokePermissionsAsSpender } from './revoke'
import type { StoredSpendPermission } from './serverExecutor'
import type { ScoutSpender } from './spender'

const KEY = 'kismetart:scout-pending-revoke'
const MAX_PER_OWNER = 20

type Queue = Record<string, StoredSpendPermission[]>

async function readQueue(): Promise<Queue> {
  try {
    const raw = await redis.get<string | Queue>(KEY)
    if (!raw) return {}
    return typeof raw === 'string' ? (JSON.parse(raw) as Queue) : raw
  } catch {
    return {}
  }
}

async function writeQueue(q: Queue): Promise<void> {
  if (Object.keys(q).length === 0) await redis.del(KEY)
  else await redis.set(KEY, JSON.stringify(q))
}

/** Remember grants to retry, merged by identity (permKey) so a re-queue can't duplicate. */
export async function queuePendingRevokes(owner: string, perms: readonly StoredSpendPermission[]): Promise<void> {
  if (perms.length === 0) return
  const q = await readQueue()
  const o = owner.toLowerCase()
  const cur = q[o] ?? []
  const have = new Set(cur.map(permKey))
  q[o] = [...cur, ...perms.filter((p) => !have.has(permKey(p)))].slice(-MAX_PER_OWNER)
  await writeQueue(q)
}

/**
 * Retry queued revokes with the spender in hand. Bounded per call (a few owners),
 * best-effort, and merged back onto a FRESH read so an owner queued while this
 * drain was submitting is not overwritten away.
 */
export async function drainPendingRevokes(spender: ScoutSpender, maxOwners = 3): Promise<void> {
  const q = await readQueue()
  const owners = Object.keys(q).slice(0, maxOwners)
  if (owners.length === 0) return
  const outcome = new Map<string, StoredSpendPermission[]>()
  for (const o of owners) {
    outcome.set(o, await revokePermissionsAsSpender(q[o], spender))
  }
  const fresh = await readQueue()
  for (const [o, failed] of outcome) {
    if (failed.length > 0) fresh[o] = failed
    else delete fresh[o]
  }
  await writeQueue(fresh)
}
