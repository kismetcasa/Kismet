/**
 * Scout persistence (server-only, Redis).
 *
 * One Scout per user (keyed by the universal Base Account address) — it maps 1:1
 * to the bounded Spend Permission granted to KISMET's spender. The on-chain Spend
 * Permission is the authoritative budget cap; we persist the Kismet-side policy
 * (watched artists + caps), lifecycle, the budget snapshot the engine plans
 * against, and the per-period ITEM count (which the on-chain dollar cap does not
 * track). Dollar spend is reconciled from the permission at run time.
 */

import { redis } from '@/lib/redis'
import type { BudgetUsage, Scout, SkipReason } from './engine'
import type { StoredSpendPermission } from './serverExecutor'

/** Outcome of the latest server run — on-open / "Run now" (runScoutServer) or a
 *  coordinated drop (dropCoordinator) — for the profile card. Written only by
 *  those run paths, never by the client. */
export interface ScoutLastRun {
  /** Unix seconds. */
  at: number
  collected: number
  skipped: number
  reason?: string
  /** Per-reason skip counts from the engine's plan, when one was made. */
  skips?: Partial<Record<SkipReason, number>>
}

export interface ScoutRecord {
  scout: Scout
  usage: BudgetUsage
  /** Display-only artist labels (lowercased address → username), so the panel
   *  shows names on reload. The engine never reads this — policy.creators (the
   *  addresses) is authoritative. */
  artistLabels?: Record<string, string>
  /** Phase 2 (autonomous): the user opted into unattended "run while away" runs. */
  away?: boolean
  /** Phase 2: the bounded Spend Permission the user granted to KISMET's spender
   *  (signature + data), used server-side to fund each collect. Absent until the
   *  user grants a budget. */
  permission?: StoredSpendPermission
  /** Phase 2: previous permissions a budget change replaced, awaiting a silent
   *  spender-side revoke (revokeAsSpender, no user signature) on the next run — so
   *  changing the budget doesn't leave an orphaned active grant. */
  supersededPermissions?: StoredSpendPermission[]
}

const key = (owner: string) => `kismetart:scout:${owner.toLowerCase()}`

// Run history lives on its OWN key, never inside the record: the record is
// rewritten whole (read-modify-write) by the run loop, the coordinator and the
// config route, so a field written from a run would add a second race window
// per run (a DELETE or a pause landing between the re-read and the write gets
// clobbered or resurrected) and every PUT would have to carry it. A plain SET
// of a separate key touches nothing else; a stray write after a delete leaves
// only a harmless key that expires.
const lastRunKey = (owner: string) => `kismetart:scout-lastrun:${owner.toLowerCase()}`
const LAST_RUN_TTL_S = 30 * 86_400

export async function getLastRun(owner: string): Promise<ScoutLastRun | null> {
  try {
    const raw = await redis.get<string | ScoutLastRun>(lastRunKey(owner))
    if (!raw) return null
    return typeof raw === 'string' ? (JSON.parse(raw) as ScoutLastRun) : raw
  } catch {
    return null
  }
}

/** Best-effort: run history is cosmetic and must never fail or delay a run. */
export async function saveLastRun(owner: string, lastRun: ScoutLastRun): Promise<void> {
  await redis.set(lastRunKey(owner), JSON.stringify(lastRun), { ex: LAST_RUN_TTL_S }).catch(() => {})
}

export async function deleteLastRun(owner: string): Promise<void> {
  await redis.del(lastRunKey(owner)).catch(() => {})
}

// Reverse index: artist address → set of owners whose agent watches them. Lets
// the drop coordinator gather every watcher of a freshly-dropped artist in one
// SMEMBERS instead of scanning all scouts. Kept in sync on every save/delete.
const watchersKey = (artist: string) => `kismetart:scout-watchers:${artist.toLowerCase()}`

/** Owners whose agent is watching `artist` (lowercased). The coordinator then
 *  reads each one's record to confirm it's live + in budget. */
export async function getWatchers(artist: string): Promise<string[]> {
  try {
    return ((await redis.smembers(watchersKey(artist))) as string[]).map((o) => o.toLowerCase())
  } catch {
    return []
  }
}

/** Apply the creators diff to the reverse index (add to newly-watched artists,
 *  remove from dropped ones). Best-effort: a stale index entry is filtered out by
 *  the coordinator's per-owner record read, so it can never cause a wrong collect. */
async function syncWatcherIndex(owner: string, before: readonly string[], after: readonly string[]): Promise<void> {
  const o = owner.toLowerCase()
  const a = new Set(after.map((x) => x.toLowerCase()))
  const b = new Set(before.map((x) => x.toLowerCase()))
  const added = [...a].filter((x) => !b.has(x))
  const removed = [...b].filter((x) => !a.has(x))
  if (added.length === 0 && removed.length === 0) return
  try {
    await Promise.all([
      ...added.map((art) => redis.sadd(watchersKey(art), o)),
      ...removed.map((art) => redis.srem(watchersKey(art), o)),
    ])
  } catch (err) {
    console.error('[scout] syncWatcherIndex failed', { owner: o, err })
  }
}

export async function getScout(owner: string): Promise<ScoutRecord | null> {
  // Stored as a JSON string; tolerate an already-parsed object (Upstash can
  // auto-deserialize) — same defensive read as lib/listings.ts.
  const raw = await redis.get<string | ScoutRecord>(key(owner))
  if (!raw) return null
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as ScoutRecord
    } catch {
      return null
    }
  }
  return raw
}

/** Batch-read records for the coordinator's watcher set (one round trip). */
export async function getScoutsBatch(owners: readonly string[]): Promise<Map<string, ScoutRecord>> {
  const out = new Map<string, ScoutRecord>()
  if (owners.length === 0) return out
  const unique = Array.from(new Set(owners.map((o) => o.toLowerCase())))
  try {
    const raws = await redis.mget<(string | ScoutRecord | null)[]>(...unique.map(key))
    for (let i = 0; i < unique.length; i++) {
      const raw = raws[i]
      if (!raw) continue
      const rec = typeof raw === 'string' ? (JSON.parse(raw) as ScoutRecord) : raw
      out.set(unique[i], rec)
    }
  } catch (err) {
    console.error('[scout] getScoutsBatch failed', { err })
  }
  return out
}

export async function saveScout(record: ScoutRecord): Promise<void> {
  const prev = await getScout(record.scout.owner)
  await redis.set(key(record.scout.owner), JSON.stringify(record))
  await syncWatcherIndex(record.scout.owner, prev?.scout.policy.creators ?? [], record.scout.policy.creators)
}

export async function deleteScout(owner: string): Promise<void> {
  const prev = await getScout(owner)
  await redis.del(key(owner))
  if (prev) await syncWatcherIndex(owner, prev.scout.policy.creators, [])
  await deleteLastRun(owner)
}
