'use client'

/**
 * Scout run loop (Mode A, in-session). The custody-agnostic SubAccountExecutor
 * (see executor.ts): the engine decides WHAT to collect; this performs the
 * funded mints through the user's collecting sub-account (popup-less within the
 * Spend Permission). Mode B (unattended, server key) is a second executor
 * behind the same seam — not built here.
 *
 * Flow: reconcile this period's spend from the on-chain permission → discover
 * the watched artists' new moments → plan with the pure engine → execute the
 * approved subset via collectInSession (prepare-collect-batch + sub-account
 * send_calls + record) → reconcile spend again. Dollar spend is always taken
 * from the on-chain permission status (authoritative); only the per-period item
 * count is carried in off-chain usage.
 */

import { planRun, rollUsage, type BudgetUsage, type Scout } from './engine'
import { discoverCandidates } from './discoverCandidates'
import { collectInSession } from './inSessionCollect'
import { getCollectingBudgetStatus, type CollectingBudget } from './baseAccount'

export interface ScoutRunSummary {
  /** Items actually collected on-chain this run. */
  collected: number
  /** Candidates considered but skipped (policy/budget/eligibility). */
  skipped: number
  /** Projected spend for this run, base units of the budget currency. */
  spent: string
  txHash?: `0x${string}`
  /** Set when nothing was collected, explaining why (for the UI). */
  reason?: string
}

async function reconcileSpend(usage: BudgetUsage, budget: CollectingBudget | null): Promise<BudgetUsage> {
  if (!budget) return usage
  try {
    const status = await getCollectingBudgetStatus(budget)
    return { ...usage, spentThisPeriod: status.currentPeriod.spend.toString() }
  } catch {
    return usage
  }
}

export async function runScout(
  scout: Scout,
  usage: BudgetUsage,
  budget: CollectingBudget | null,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ summary: ScoutRunSummary; usage: BudgetUsage }> {
  if (scout.status !== 'active') {
    return { summary: { collected: 0, skipped: 0, spent: '0', reason: 'paused' }, usage }
  }

  // Roll the period, then take this period's spend from on-chain truth.
  const working = await reconcileSpend(rollUsage(scout.budget, usage, now), budget)

  const candidates = await discoverCandidates(scout.policy.creators)
  if (candidates.length === 0) {
    return { summary: { collected: 0, skipped: 0, spent: '0', reason: 'nothing new from your artists' }, usage: working }
  }

  const plan = planRun(scout, candidates, working, now)
  if (plan.toCollect.length === 0) {
    return {
      summary: { collected: 0, skipped: plan.decisions.length, spent: '0', reason: 'nothing within your budget/policy right now' },
      usage: plan.endUsage,
    }
  }

  const result = await collectInSession(
    plan.toCollect.map((c) => ({ collection: c.collection, tokenId: c.tokenId })),
  )

  // Item count from what actually landed; dollar spend re-reconciled on-chain.
  const endUsage = await reconcileSpend(
    {
      periodStart: plan.endUsage.periodStart,
      spentThisPeriod: plan.endUsage.spentThisPeriod,
      itemsThisPeriod: working.itemsThisPeriod + result.collected,
    },
    budget,
  )

  return {
    summary: {
      collected: result.collected,
      skipped: result.skipped.length,
      spent: plan.projectedSpend,
      txHash: result.txHash,
    },
    usage: endUsage,
  }
}
