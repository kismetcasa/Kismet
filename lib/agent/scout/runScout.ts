'use client'

/**
 * Scout run loop (Mode A, in-session). The custody-agnostic SubAccountExecutor
 * (see executor.ts): the engine decides WHAT to collect; this performs the
 * funded mints through the user's collecting sub-account (popup-less within the
 * Spend Permission). Mode B (unattended, server key) is a second executor
 * behind the same seam — not built here.
 *
 * Authoritative state comes from on-chain truth, never client/computed values:
 *   - the period window + dollar spend are read from the Spend Permission
 *     (getCollectingBudgetStatus → currentPeriod), so the engine and the chain
 *     share one window;
 *   - "new drops" is enforced by excluding what the sub-account already owns
 *     (its collected set) from the plan;
 *   - the per-period item count is charged CONSERVATIVELY (planned dispatch,
 *     even on a confirm-timeout) so the item cap can't be silently exceeded.
 */

import { planRun, type BudgetUsage, type Scout } from './engine'
import { discoverCandidates } from './discoverCandidates'
import { collectInSession } from './inSessionCollect'
import { getCollectingBudgetStatus, type CollectingBudget } from './baseAccount'

export interface ScoutRunSummary {
  /** Items actually collected on-chain this run. */
  collected: number
  /** Candidates considered but skipped (policy/budget/already-owned/eligibility). */
  skipped: number
  /** Projected spend for this run, base units of the budget currency. */
  spent: string
  txHash?: `0x${string}`
  /** Set when nothing was collected (or a run error), explaining why. */
  reason?: string
}

/** The sub-account's collected set as `collection:tokenId` keys (lowercased
 *  collection), matching the engine's already-collected key format. */
async function fetchCollectedKeys(subAccount: string): Promise<Set<string>> {
  try {
    const r = await fetch(`/api/timeline?collector=${subAccount}&limit=200`)
    if (!r.ok) return new Set()
    const d = (await r.json()) as { moments?: Array<{ address?: string; token_id?: string }> }
    return new Set(
      (d.moments ?? [])
        .filter((m) => m.address && m.token_id)
        .map((m) => `${m.address!.toLowerCase()}:${m.token_id}`),
    )
  } catch {
    return new Set()
  }
}

/** This period's window start + spend from the on-chain permission
 *  (authoritative); falls back to the stored usage if the read fails. */
async function onChainPeriod(
  budget: CollectingBudget | null,
  usage: BudgetUsage,
): Promise<{ periodStart: number; spent: string }> {
  if (!budget) return { periodStart: usage.periodStart, spent: usage.spentThisPeriod }
  try {
    const st = await getCollectingBudgetStatus(budget)
    return { periodStart: st.currentPeriod.start, spent: st.currentPeriod.spend.toString() }
  } catch {
    return { periodStart: usage.periodStart, spent: usage.spentThisPeriod }
  }
}

export async function runScout(
  scout: Scout,
  usage: BudgetUsage,
  budget: CollectingBudget | null,
  subAccount: string | undefined,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ summary: ScoutRunSummary; usage: BudgetUsage }> {
  if (scout.status !== 'active') {
    return { summary: { collected: 0, skipped: 0, spent: '0', reason: 'paused' }, usage }
  }

  // 1. Anchor the period window + spend to on-chain truth; reset the item count
  //    when the on-chain period has rolled.
  const { periodStart, spent } = await onChainPeriod(budget, usage)
  const items = usage.periodStart === periodStart ? usage.itemsThisPeriod : 0
  const working: BudgetUsage = { periodStart, spentThisPeriod: spent, itemsThisPeriod: items }

  // 2. Discover watched artists' drops, excluding what the sub-account already
  //    owns (only collect NEW drops).
  const candidates = await discoverCandidates(scout.policy.creators)
  if (candidates.length === 0) {
    return { summary: { collected: 0, skipped: 0, spent: '0', reason: 'nothing new from your artists' }, usage: working }
  }
  const alreadyCollected = subAccount ? await fetchCollectedKeys(subAccount) : undefined
  const plan = planRun(scout, candidates, working, now, alreadyCollected)
  if (plan.toCollect.length === 0) {
    return {
      summary: { collected: 0, skipped: plan.decisions.length, spent: '0', reason: 'nothing within your budget/policy right now' },
      usage: plan.endUsage,
    }
  }

  // 3. Execute. Charge the item cap by the PLANNED dispatch count whether the run
  //    resolves or throws — a confirm-timeout may still land on-chain, so fail
  //    safe (never under-count → never exceed the cap). Dollar spend is re-read
  //    from chain below, so it stays exact regardless.
  const planned = plan.toCollect.length
  let collected = 0
  let txHash: `0x${string}` | undefined
  let reason: string | undefined
  try {
    const result = await collectInSession(plan.toCollect.map((c) => ({ collection: c.collection, tokenId: c.tokenId })))
    collected = result.collected
    txHash = result.txHash
  } catch (e) {
    reason = e instanceof Error ? e.message : 'collect failed'
  }

  const endSpent = (await onChainPeriod(budget, working)).spent
  const endUsage: BudgetUsage = {
    periodStart,
    spentThisPeriod: endSpent,
    itemsThisPeriod: working.itemsThisPeriod + planned,
  }
  return {
    summary: {
      collected,
      skipped: plan.decisions.length - planned,
      spent: plan.projectedSpend,
      txHash,
      ...(reason ? { reason } : {}),
    },
    usage: endUsage,
  }
}
