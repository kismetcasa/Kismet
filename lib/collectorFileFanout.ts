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
 * ~11-13 Redis commands through writeNotification + push (the extra one is
 * writeNotification's smart-wallet alias resolution, which this path does NOT
 * opt out of — unlike the follower fan-out, a collector audience CAN in
 * principle contain a contract that received an edition), so the audience is
 * CEILING-REFUSED (never silently truncated), delivery is paced in small
 * batches with the push AWAITED (bounding in-flight HTTP — the detached-push
 * shape is the OOM-incident shape), and the 24h cooldown is a SET NX lock.
 *
 * CRASH-SAFETY: the lock's VALUE is the run's progress cursor, advanced
 * after every delivered batch (SET keepTtl — the 24h window never extends).
 * A process death mid-fanout therefore leaves `done:false` at the last
 * completed batch; the notify route reads that and queues a RESUME instead
 * of answering 409, and the resume walks the same deterministically-sorted
 * audience from the cursor. The audience can shift between crash and resume
 * (new collectors sort into earlier positions), so resume is best-effort —
 * writeNotification's own suppressions make a rare repeat harmless, and a
 * rare skip is caught by the on-page update badge (§6.4's floor).
 *
 * The lock is CONSUMED (kept for the 24h) only when at least one
 * notification was actually written; every nothing-delivered outcome
 * releases it so a transient failure can't burn the artist's one notify.
 */

/** Refusal ceiling. Above this the artist gets the passive badge path only —
 *  raising it is an ops decision that arrives with a raised Upstash budget
 *  cap (≤2,000 ≈ ≤24K commands ≈ ~4% of current monthly volume). */
export const CFILE_FANOUT_CEILING = 2000

const FANOUT_BATCH = 50

/** The notify-lock's value: run progress, readable by the notify route. */
export interface CfileNotifyProgress {
  cursor: number
  total: number
  done: boolean
  startedAt: number
}

export function parseNotifyProgress(raw: unknown): CfileNotifyProgress | null {
  if (!raw) return null
  try {
    const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as CfileNotifyProgress
    return typeof p?.cursor === 'number' && typeof p?.done === 'boolean' ? p : null
  } catch {
    return null
  }
}

export type CfileNotifyOutcome =
  | { ok: true; delivered: number; filteredOut: number }
  | { ok: false; reason: 'cooldown' | 'no-audience' | 'over-ceiling' | 'holders-unavailable'; audience?: number }

/**
 * Notify every current-holder in the artwork's audience that the file
 * changed. Call from `after()` — total wall clock is deliberately paced.
 * `resume: true` continues an interrupted run from its stored cursor
 * (the notify route decides that from the lock's progress value).
 */
export async function notifyCollectorsOfUpdate(input: {
  collection: string
  tokenId: string
  actor: string
  note?: string
  resume?: boolean
}): Promise<CfileNotifyOutcome> {
  const { collection, tokenId, actor } = input
  const ref = cfileRef(collection, tokenId)
  const lockKey = cfileNotifyLockKey(ref)

  const releaseLock = () => redis.del(lockKey).catch(() => {})
  const writeProgress = (p: CfileNotifyProgress, opts: { init?: boolean } = {}) =>
    opts.init
      ? redis.set(lockKey, JSON.stringify(p), { nx: true, ex: CFILE_NOTIFY_COOLDOWN_SECS })
      : // keepTtl: progress updates must never extend the 24h window.
        redis.set(lockKey, JSON.stringify(p), { keepTtl: true })

  try {
    // Deterministic order is what makes the cursor meaningful across a
    // crash/resume boundary.
    const audience = (await getCfileAudience(collection, tokenId))
      .filter((a) => a !== actor.toLowerCase())
      .sort()
    if (audience.length === 0) {
      if (input.resume) await releaseLock()
      return { ok: false, reason: 'no-audience' }
    }
    if (audience.length > CFILE_FANOUT_CEILING) {
      if (input.resume) await releaseLock()
      return { ok: false, reason: 'over-ceiling', audience: audience.length }
    }

    let cursor = 0
    if (input.resume) {
      const prior = parseNotifyProgress(await redis.get(lockKey).catch(() => null))
      if (!prior || prior.done) return { ok: false, reason: 'cooldown' }
      cursor = Math.min(prior.cursor, audience.length)
    } else {
      const acquired =
        (await writeProgress(
          { cursor: 0, total: audience.length, done: false, startedAt: Date.now() },
          { init: true },
        )) === 'OK'
      if (!acquired) return { ok: false, reason: 'cooldown' }
    }

    const meta = await getMomentMeta(collection.toLowerCase(), tokenId).catch(() => null)
    const note = input.note?.trim() ? input.note.trim().slice(0, 140) : undefined

    let delivered = 0
    let filteredOut = 0
    for (; cursor < audience.length; cursor += FANOUT_BATCH) {
      const batch = audience.slice(cursor, cursor + FANOUT_BATCH)
      // Current-holder filter per batch (ex-holders can no longer download,
      // so "tap to get v2" would 403 them). null = RPC failure — stop HERE:
      // the cursor already persisted points at this batch, so a retry
      // resumes exactly where delivery stopped instead of burning the day.
      const holding = await holdsEditionBatch(collection, tokenId, batch)
      if (holding === null) {
        if (delivered === 0 && cursor === 0 && !input.resume) {
          // Nothing delivered on a fresh run — release rather than strand a
          // consumed cooldown on a transient RPC blip.
          await releaseLock()
        }
        return { ok: false, reason: 'holders-unavailable' }
      }
      const holders = batch.filter((a) => holding[a])
      filteredOut += batch.length - holders.length

      await Promise.all(
        holders.map((recipient) =>
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
            // entry landed; counting resolutions would make the zero-
            // delivered release below dead code.
            if (wrote) delivered++
          }),
        ),
      )
      await writeProgress({
        cursor: cursor + FANOUT_BATCH,
        total: audience.length,
        done: false,
        startedAt: Date.now(),
      }).catch(() => {})
    }

    if (delivered === 0 && !input.resume) {
      // Full scan, nothing landed (all filtered out, or Redis degraded under
      // writeNotification) — give the artist their retry.
      await releaseLock()
      return { ok: true, delivered: 0, filteredOut }
    }
    await writeProgress({
      cursor: audience.length,
      total: audience.length,
      done: true,
      startedAt: Date.now(),
    }).catch(() => {})
    return { ok: true, delivered, filteredOut }
  } catch (err) {
    // Unexpected failure: on a fresh run that delivered nothing the lock is
    // released above where provable; here we keep whatever progress stands —
    // the notify route turns an un-done lock into a resume, never a 409.
    console.error('[cfile-fanout] aborted', {
      ref,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, reason: 'holders-unavailable' }
  }
}
