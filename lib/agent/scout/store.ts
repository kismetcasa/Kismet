/**
 * Scout persistence (server-only, Redis).
 *
 * One Scout per user (keyed by the universal Base Account address) — it maps 1:1
 * to the single collecting sub-account + Spend Permission. The on-chain Spend
 * Permission is the authoritative budget cap; we persist the Kismet-side policy
 * (watched artists + caps), lifecycle, the budget snapshot the engine plans
 * against, and the per-period ITEM count (which the on-chain dollar cap does not
 * track). Dollar spend is reconciled from the permission at run time.
 */

import { redis } from '@/lib/redis'
import type { BudgetUsage, Scout } from './engine'

export interface ScoutRecord {
  scout: Scout
  usage: BudgetUsage
}

const key = (owner: string) => `kismetart:scout:${owner.toLowerCase()}`

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

export async function saveScout(record: ScoutRecord): Promise<void> {
  await redis.set(key(record.scout.owner), JSON.stringify(record))
}

export async function deleteScout(owner: string): Promise<void> {
  await redis.del(key(owner))
}
