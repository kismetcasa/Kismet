/**
 * Phase 2 autonomous run loop (server-side). Triggered by a session-authed run
 * route (v1: on-open + "Run now") or, later, a QStash cron. The user's bounded
 * Spend Permission funds each collect; KISMET's spender executes it — no taps.
 *
 * Authoritative state is on-chain truth, never client/computed values:
 *   - the period window + spend come from getPermissionStatus, so the engine and
 *     the chain share one window and one allowance;
 *   - "new drops only" excludes what the user already owns (their collected set);
 *   - the executor re-resolves each price on-chain before spending.
 */

import { getPermissionStatus, prepareRevokeCallData } from '@base-org/account/spend-permission'
import type { Address, Hex } from 'viem'
import { redis } from '@/lib/redis'
import { writeNotification } from '@/lib/notifications'
import { planRun, type BudgetUsage } from './engine'
import { getScout, saveScout, type ScoutRecord } from './store'
import { discoverCore } from './discoverCore'
import { createSpendPermissionExecutor, type StoredSpendPermission } from './serverExecutor'
import type { ScoutSpender } from './spender'

export interface ServerRunSummary {
  collected: number
  skipped: number
  reason?: string
}

/** The user's collected set as `collection:tokenId` keys, so a new run only
 *  collects drops they don't already own. Returns `null` (NOT an empty set) when
 *  the read fails, so the caller can FAIL CLOSED — re-collecting drops the user
 *  already owns would waste their budget on duplicates. An empty set means they
 *  genuinely own nothing. */
async function fetchCollectedKeys(owner: string, baseUrl: string): Promise<Set<string> | null> {
  try {
    const r = await fetch(`${baseUrl}/api/timeline?collector=${owner}&limit=200`)
    if (!r.ok) return null
    const d = (await r.json()) as { moments?: Array<{ address?: string; token_id?: string }> }
    return new Set(
      (d.moments ?? [])
        .filter((m) => m.address && m.token_id)
        .map((m) => `${m.address!.toLowerCase()}:${m.token_id}`),
    )
  } catch {
    return null
  }
}

/** Record one verified collect on the proof-gated /api/collect (it re-checks the
 *  TransferSingle on `txHash` against `account` on-chain, so no session needed). */
async function recordCollect(
  baseUrl: string,
  account: string,
  candidate: { collection: string; tokenId: string; currency: 'eth' | 'usdc' },
  txHash: Hex,
  amount: number,
): Promise<void> {
  try {
    await fetch(`${baseUrl}/api/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        moment: { collectionAddress: candidate.collection, tokenId: candidate.tokenId },
        account,
        amount,
        currency: candidate.currency,
        txHash,
      }),
    })
  } catch {
    /* best-effort: the mint is on-chain regardless; the record/feed is cosmetic */
  }
}

/**
 * Silently revoke any permissions a budget change superseded, using the spender
 * (revokeAsSpender — no user signature). Best-effort: a transient failure stays
 * queued for the next run; an already-revoked/expired one is just dropped (so the
 * queue can't get stuck). Clears the queue (or the revoked subset) from the record.
 */
async function drainSupersededPermissions(record: ScoutRecord, spender: ScoutSpender): Promise<void> {
  const pending = record.supersededPermissions
  if (!pending || pending.length === 0) return
  const remaining: StoredSpendPermission[] = []
  for (const old of pending) {
    try {
      const status = await getPermissionStatus(old)
      if (!status.isRevoked && !status.isExpired) {
        const call = await prepareRevokeCallData(old)
        await spender.sendCalls([{ to: call.to as Address, data: call.data as Hex, value: BigInt(call.value) }])
      }
      // revoked just now, or already revoked/expired → drop from the queue
    } catch {
      remaining.push(old) // transient failure (e.g. RPC) — retry next run
    }
  }
  if (remaining.length === pending.length) return // nothing changed
  if (remaining.length > 0) record.supersededPermissions = remaining
  else delete record.supersededPermissions
  await saveScout(record)
}

export async function runScoutServer(params: {
  owner: string
  baseUrl: string
  spender: ScoutSpender
  now?: number
}): Promise<ServerRunSummary> {
  const { owner, baseUrl, spender } = params
  const now = params.now ?? Math.floor(Date.now() / 1000)

  // Kill switch — halt all autonomous spending instantly (set the Redis flag).
  try {
    if (await redis.get('kismetart:scout-killswitch')) return { collected: 0, skipped: 0, reason: 'kill switch engaged' }
  } catch {
    /* flag store unreachable — proceed; per-collect guards still bound spend */
  }

  const record = await getScout(owner)
  if (!record?.scout || !record.permission) return { collected: 0, skipped: 0, reason: 'no agent' }

  // Clean up any permission a budget change superseded (silent, best-effort) before
  // doing anything else, so it happens on the next run regardless of run outcome.
  await drainSupersededPermissions(record, spender)

  const { scout, permission } = record
  if (!record.away || scout.status !== 'active' || scout.mode !== 'auto') {
    return { collected: 0, skipped: 0, reason: 'not an active away scout' }
  }
  const recipient = owner as Address

  // 1. Anchor the budget window + spend to the on-chain permission.
  const status = await getPermissionStatus(permission)
  if (!status.isActive) return { collected: 0, skipped: 0, reason: 'permission inactive' }
  const periodStart = status.currentPeriod.start
  const items = record.usage.periodStart === periodStart ? record.usage.itemsThisPeriod : 0
  const usage: BudgetUsage = {
    periodStart,
    spentThisPeriod: status.currentPeriod.spend.toString(),
    itemsThisPeriod: items,
  }

  // 2. Discover watched artists' drops; plan within budget/policy, excluding owned.
  const candidates = await discoverCore(scout.policy.creators, baseUrl)
  if (candidates.length === 0) return { collected: 0, skipped: 0, reason: 'nothing new from your artists' }

  // The timeline collected-set is a BINARY (owned/not) pre-filter, correct only
  // for the default 1-edition target — it keeps the engine's item-cap accounting
  // honest by not planning owned drops. For a multi-edition target it would
  // wrongly stop at edition 1, so we skip it there and rely on the executor's
  // authoritative on-chain balance check (balanceOf >= editions) instead.
  const editions = Math.max(1, Math.floor(scout.policy.maxEditionsPerDrop ?? 1))
  let planOwned: Set<string> = new Set()
  if (editions === 1) {
    const owned = await fetchCollectedKeys(owner, baseUrl)
    if (owned === null) return { collected: 0, skipped: 0, reason: 'could not verify your collected set' }
    planOwned = owned
  }
  // Anchor the engine's period accounting to the on-chain currentPeriod.start
  // (resolved above), so the off-chain item counter mirrors the SpendPermissionManager
  // exactly and can't drift by a period under clock skew near a boundary.
  const plan = planRun(scout, candidates, usage, now, planOwned, periodStart)
  if (plan.toCollect.length === 0) {
    return { collected: 0, skipped: plan.decisions.length, reason: 'nothing within your budget/policy' }
  }

  // 3. Execute each: spend (bounded) + mint to the user, via the spender. The
  //    executor re-resolves price on-chain; the permission cap is the hard guard.
  const executor = createSpendPermissionExecutor({ permission, spender, recipient })
  let collected = 0
  let skipped = plan.decisions.length - plan.toCollect.length
  for (const candidate of plan.toCollect) {
    try {
      const { txHash, quantity } = await executor.collect(scout, candidate)
      await recordCollect(baseUrl, owner, candidate, txHash, Number(quantity))
      collected += 1
    } catch {
      skipped += 1 // per-item failure (sold out, race, allowance) — keep going
    }
  }

  // 4. Persist usage from on-chain truth; notify the user.
  try {
    const end = await getPermissionStatus(permission)
    const endUsage: BudgetUsage = {
      periodStart,
      spentThisPeriod: end.currentPeriod.spend.toString(),
      itemsThisPeriod: items + collected,
    }
    await saveScout({ ...record, usage: endUsage })
  } catch {
    /* the on-chain cap is the real guard; a stale stored count is harmless */
  }
  if (collected > 0) {
    await writeNotification({
      type: 'agent_collect',
      recipient: owner,
      amount: collected,
      currency: scout.budget.currency,
    })
  }

  return { collected, skipped }
}
