/**
 * Idempotency window for /api/collect's (tx, collection, token, account) lock.
 * After a successful record, repeat POSTs inside this window return
 * ok-without-side-effects, so a replay of a legitimate mint can't inflate
 * trending or flood notifications. 30 days covers the realistic re-submit
 * horizon while keeping the keyspace bounded — and it is therefore ALSO the
 * horizon past which the route can no longer tell a replay from a first
 * record (the lock that would have said so has expired). See
 * isStaleCollectRecord.
 */
export const COLLECT_IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60

/** /api/collect's per-IP budget per minute — the route enforces it, and the
 *  sweep's record schedule (lib/sweepBatch) sizes its retries to it. */
export const COLLECT_RATE_LIMIT_PER_MINUTE = 60

/**
 * A record whose MINT predates the idempotency window is a backfill, not a
 * sale event. The lock cannot distinguish "recorded five months ago, replayed
 * now" from "never recorded, reconciled now" once it has expired — and the
 * two produce identical requests: a pasted record URL, a stale tab, a
 * reconcile script. Treating both as a fresh sale is what put a
 * months-old piece at the top of the latest-sales feed and sent its artist
 * a five-month-late "collected" notice. So past the window the route
 * updates only the durable, idempotent indexes (the collector's list, the
 * audience index, the artwork's collect log — all keyed on facts the chain
 * proves) and skips the event-shaped effects: the trending increment and
 * the notifications. The latest-sales score is safe either way because it
 * is the mint's block time under ZADD GT (never a wall clock, never lowered).
 *
 * `mintedAtMs` is the mint's block time in ms (or the record time when the
 * verification could not read the block — the pre-existing behavior, which
 * never classifies as stale).
 */
export function isStaleCollectRecord(mintedAtMs: number, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(mintedAtMs)) return false
  return nowMs - mintedAtMs > COLLECT_IDEMPOTENCY_TTL_SECONDS * 1000
}
