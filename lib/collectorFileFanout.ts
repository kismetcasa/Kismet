import 'server-only'
import { redis } from './redis'
import { writeNotification, getMomentMeta } from './notifications'
import { holdsEditionBatch } from './ownership'
import {
  cfileNotifyLockKey,
  getCfileAudience,
  CFILE_NOTIFY_COOLDOWN_SECS,
} from './collectorFile'
import { cfileRef } from './collectorFileCore'

/**
 * The file_update fan-out (COLLECTOR_DOWNLOADS_DESIGN.md §6.2) — the one
 * bulk-notification path in the app with an explicit cost model, because it
 * runs against a datastore with a hard-stop budget cap: each recipient costs
 * ~10-12 Redis commands through writeNotification + push, so the audience is
 * CEILING-REFUSED (never silently truncated), delivery is paced in small
 * batches with the push AWAITED (bounding in-flight HTTP — the detached-push
 * shape is the OOM-incident shape), and the 24h cooldown is a SET NX lock
 * that is only CONSUMED when at least one notification was actually written.
 */

/** Refusal ceiling. Above this the artist gets the passive badge path only —
 *  raising it is an ops decision that arrives with a raised Upstash budget
 *  cap (≤2,000 ≈ ≤24K commands ≈ ~4% of current monthly volume). */
export const CFILE_FANOUT_CEILING = 2000

const FANOUT_BATCH = 50

export type CfileNotifyOutcome =
  | { ok: true; delivered: number; filteredOut: number }
  | { ok: false; reason: 'cooldown' | 'no-audience' | 'over-ceiling' | 'holders-unavailable'; audience?: number }

/**
 * Notify every current-holder in the artwork's audience that the file
 * changed. Call from `after()` — total wall clock is deliberately paced.
 *
 * Failure semantics (the part rev-1 got wrong): the cooldown lock is
 * acquired up front (racing notify clicks must not double-blast 2,000
 * people) but RELEASED again on any outcome that delivered nothing — a
 * transient balanceOfBatch failure must not burn the artist's one notify
 * for the day.
 */
export async function notifyCollectorsOfUpdate(input: {
  collection: string
  tokenId: string
  actor: string
  note?: string
}): Promise<CfileNotifyOutcome> {
  const { collection, tokenId, actor } = input
  const ref = cfileRef(collection, tokenId)
  const lockKey = cfileNotifyLockKey(ref)

  const acquired =
    (await redis.set(lockKey, String(Date.now()), { nx: true, ex: CFILE_NOTIFY_COOLDOWN_SECS })) === 'OK'
  if (!acquired) return { ok: false, reason: 'cooldown' }

  const releaseLock = () => redis.del(lockKey).catch(() => {})

  try {
    const audience = (await getCfileAudience(collection, tokenId)).filter(
      (a) => a !== actor.toLowerCase(),
    )
    if (audience.length === 0) {
      await releaseLock()
      return { ok: false, reason: 'no-audience' }
    }
    if (audience.length > CFILE_FANOUT_CEILING) {
      await releaseLock()
      return { ok: false, reason: 'over-ceiling', audience: audience.length }
    }

    // Current-holder filter: ex-holders can no longer download, so "tap to
    // get v2" would 403 them. null = RPC failure — abort WITHOUT consuming
    // the cooldown (an all-false map would silently notify nobody).
    const holding = await holdsEditionBatch(collection, tokenId, audience)
    if (holding === null) {
      await releaseLock()
      return { ok: false, reason: 'holders-unavailable' }
    }
    const holders = audience.filter((a) => holding[a])
    if (holders.length === 0) {
      await releaseLock()
      return { ok: true, delivered: 0, filteredOut: audience.length }
    }

    const meta = await getMomentMeta(collection.toLowerCase(), tokenId).catch(() => null)
    const note = input.note?.trim() ? input.note.trim().slice(0, 140) : undefined

    let delivered = 0
    for (let i = 0; i < holders.length; i += FANOUT_BATCH) {
      await Promise.all(
        holders.slice(i, i + FANOUT_BATCH).map((recipient) =>
          writeNotification({
            type: 'file_update',
            recipient,
            actor,
            tokenAddress: collection.toLowerCase(),
            tokenId,
            ...(meta?.name ? { tokenName: meta.name } : {}),
            ...(note ? { note } : {}),
            // Recipients are proven holders of the artwork — skip the 2
            // per-recipient priority reads (isPriority returns true for
            // file_update anyway; this keeps the batch at its floor cost).
            _forcePriority: true,
            // Bound in-flight push HTTP to the batch: each awaited dispatch
            // holds ≤10s (SEND_TIMEOUT_MS) and ≤FANOUT_BATCH run at once.
            _awaitPush: true,
          }).then((wrote) => {
            // writeNotification never throws — it REPORTS whether the bell
            // entry landed. Counting resolutions instead of writes would make
            // the delivered===0 cooldown release below dead code and burn the
            // artist's one notify/day on a total Redis write failure.
            if (wrote) delivered++
          }),
        ),
      )
    }

    if (delivered === 0) {
      // Nothing landed (writeNotification swallows its own failures) — give
      // the artist their retry rather than a silently-spent cooldown.
      await releaseLock()
    }
    return { ok: true, delivered, filteredOut: audience.length - holders.length }
  } catch (err) {
    await releaseLock()
    console.error('[cfile-fanout] aborted', {
      ref,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'holders-unavailable' }
  }
}
