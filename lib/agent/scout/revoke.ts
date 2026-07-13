/**
 * Spend-Permission revocation helpers, shared by every path that must retire a
 * grant to KISMET's autonomous spender: the on-open run loop (superseded-budget
 * cleanup), the drop coordinator (the only server-driven path for set-and-forget
 * users), and turn-off/delete. Revoking here uses `revokeAsSpender` — the spender
 * submits, so NO user signature is needed and turn-off doesn't depend on the
 * browser wallet prompt completing.
 *
 * Why this matters: grants are created with no `end`, so the SDK defaults `end` to
 * the max timestamp — a permission never expires on its own. If a superseded (or
 * the current) permission is not revoked, it stays a live, spendable authorization
 * to our spender forever, invisible to the UI. So every "the user reduced or
 * removed their exposure" path routes through here.
 */

import { getPermissionStatus, prepareRevokeCallData } from '@base-org/account/spend-permission'
import type { Address, Hex } from 'viem'
import { getScout, saveScout, type ScoutRecord } from './store'
import type { ScoutSpender } from './spender'
import type { StoredSpendPermission } from './serverExecutor'

/** Stable identity for a stored permission (token+allowance+period+start) — the
 *  same key the scout route uses, so the drain removes exactly what was queued. */
const permId = (p: StoredSpendPermission): string => {
  const d = p.permission
  return `${d.token}:${d.allowance}:${d.period}:${d.start}`.toLowerCase()
}

/**
 * Revoke each still-active permission via the spender (`revokeAsSpender` — the
 * submitted calldata sets msg.sender = the configured spender = permission.spender,
 * so the on-chain revoke lands). Already revoked/expired ones are skipped. Best-
 * effort per entry: returns the subset that FAILED (e.g. a transient RPC error) so
 * callers can re-queue them for a later retry rather than silently dropping a still-
 * active grant.
 */
export async function revokePermissionsAsSpender(
  perms: readonly StoredSpendPermission[],
  spender: ScoutSpender,
): Promise<StoredSpendPermission[]> {
  const failed: StoredSpendPermission[] = []
  for (const perm of perms) {
    try {
      const status = await getPermissionStatus(perm)
      if (status.isRevoked || status.isExpired) continue // already inert → drop from any queue
      const call = await prepareRevokeCallData(perm)
      await spender.sendCalls([{ to: call.to as Address, data: call.data as Hex, value: BigInt(call.value) }])
    } catch {
      failed.push(perm) // transient failure → keep for retry
    }
  }
  return failed
}

/**
 * Silently revoke any permissions a budget change superseded. Best-effort: a
 * transient failure stays queued (retried next run); an already-revoked/expired one
 * is dropped so the queue can't get stuck. Persists the revoked subset off the
 * record. A no-op when the queue is empty (the overwhelming common case), so it's
 * cheap to call on every server-driven path.
 */
export async function drainSupersededPermissions(record: ScoutRecord, spender: ScoutSpender): Promise<void> {
  const pending = record.supersededPermissions
  if (!pending || pending.length === 0) return
  const failed = await revokePermissionsAsSpender(pending, spender)
  const failedIds = new Set(failed.map(permId))
  const retiredIds = new Set(pending.filter((p) => !failedIds.has(permId(p))).map(permId))
  if (retiredIds.size === 0) return // nothing retired → nothing to persist

  // Re-read before persisting: this may be called with a snapshot taken earlier in
  // a long coordination, so writing it back verbatim could clobber a config change
  // (pause / budget / away) the user made meanwhile. Remove ONLY the entries we
  // retired, by identity, preserving whatever the fresh record has since queued.
  const fresh = (await getScout(record.scout.owner)) ?? record
  const freshQueue = fresh.supersededPermissions ?? []
  const remaining = freshQueue.filter((p) => !retiredIds.has(permId(p)))
  if (remaining.length === freshQueue.length) return // fresh queue had none of them
  if (remaining.length > 0) fresh.supersededPermissions = remaining
  else delete fresh.supersededPermissions
  await saveScout(fresh)
}
