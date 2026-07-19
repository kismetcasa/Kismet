import { redis } from './redis'

// Durable-ish audit trail for privileged admin actions (kill switch, pause,
// blacklist, erase, taint, pass-validity, quota, content hide). Best practice
// for these is who/what/when + outcome in an append-only store that ordinary
// app code can't rewrite. Our constraints (single Upstash Redis, no separate
// log infra) make this append-only-BY-CONVENTION, not WORM / hash-chained — a
// fuller tamper-evident trail would need separate storage. Two sinks so a
// record survives even when Redis is the thing that failed:
//   1. console.log('[audit]')  → the Coolify docker-logs trail (off-host, grep-able)
//   2. a bounded Redis list     → queryable via `LRANGE kismetart:audit:admin 0 -1`
const AUDIT_KEY = 'kismetart:audit:admin'
const MAX_ENTRIES = 5000

export interface AdminAuditEntry {
  ts: number
  actor: string
  action: string
  target?: string
  meta?: Record<string, unknown>
}

/**
 * Record a completed privileged action. `actor` MUST be the verified session
 * signer (never client input). Best-effort: this never throws into, nor blocks
 * the outcome of, the action it records — an audit-write failure must not fail
 * the mutation. Call it AFTER the mutation succeeds so the trail reflects real
 * state changes.
 */
export async function recordAdminAction(
  action: string,
  fields: { actor: string; target?: string; meta?: Record<string, unknown> },
): Promise<void> {
  // The WHOLE body is guarded: an audit-write failure — including a
  // JSON.stringify throw on some future caller's meta (e.g. a BigInt) — must
  // never propagate into, or fail, the mutation this records. That "never
  // throws" guarantee is the whole reason it's called after the action has
  // already succeeded.
  try {
    const entry: AdminAuditEntry = {
      ts: Date.now(),
      actor: fields.actor.toLowerCase(),
      action,
      ...(fields.target ? { target: fields.target } : {}),
      ...(fields.meta ? { meta: fields.meta } : {}),
    }
    // Serialize once so the off-host log line and the stored record are identical.
    const json = JSON.stringify(entry)
    // Off-host trail first, so the record exists even if the Redis append fails.
    console.log('[audit]', json)
    // Append-only + bounded. LPUSH newest-first, LTRIM caps growth; both are
    // issued same-tick so auto-pipelining collapses them to one round trip
    // (LPUSH executes before LTRIM in the pipeline, so the new entry survives).
    await Promise.all([
      redis.lpush(AUDIT_KEY, json),
      redis.ltrim(AUDIT_KEY, 0, MAX_ENTRIES - 1),
    ])
  } catch (err) {
    console.error('[audit] record failed:', action, err instanceof Error ? err.message : String(err))
  }
}
