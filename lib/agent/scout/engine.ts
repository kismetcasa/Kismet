/**
 * Scout engine — the pure, dependency-free core of budgeted auto-collecting.
 *
 * A "Scout" is a named standing agent: a USDC/ETH budget (backed on-chain by a
 * Base Account Spend Permission) plus a Kismet-enforced policy of WHAT to
 * collect. This module owns the two things that must be exactly right for
 * autonomy to be safe at scale:
 *
 *   1. Budget accounting that MIRRORS Base's SpendPermissionManager period
 *      semantics, so our off-chain plan never proposes a spend the on-chain cap
 *      would reject (which would surface as failed/ reverted auto-collects).
 *   2. A deterministic policy decision for every candidate, with an explicit
 *      reason when we skip — auditable and unit-testable.
 *
 * Zero imports on purpose: no network, no viem, no secrets. It's a pure
 * function of (scout, candidates, usage, now) so it can be exhaustively tested
 * (see scripts/verify-agent-scout.ts) and reused identically by the Propose UI
 * and the Auto executor. The on-chain spend + mint is a separate, injected
 * concern (see ./scout/executor.ts), keeping this layer custody-agnostic.
 */

// ───────────────────────── types ─────────────────────────

export type Currency = 'eth' | 'usdc'
export type ScoutMode = 'propose' | 'auto'
export type ScoutStatus = 'active' | 'paused'

/** Budget, mirroring a Base Account Spend Permission. Amounts are base units
 *  (wei for ETH, 6dp for USDC) as decimal strings (JSON/Redis-safe). */
export interface ScoutBudget {
  currency: Currency
  /** Allowance per period, base units. */
  allowance: string
  /** Recurring period length in seconds (Spend Permission period). */
  periodSeconds: number
  /** Permission validity window, unix seconds. */
  start: number
  end: number
}

/** The Kismet-enforced "what to collect" policy. Spend Permissions cap dollars,
 *  not which contracts get called — so these controls live here. Address lists
 *  are compared case-insensitively. */
export interface ScoutPolicy {
  /** Allowlist of collection addresses; empty = open discovery. */
  collections: string[]
  /** Allowlist of creator addresses; empty = any creator. */
  creators: string[]
  blockedCollections: string[]
  blockedCreators: string[]
  /** Max price for a single collect, base units of the budget currency. */
  maxItemPrice: string
  /** Hard cap on items collected per budget period (>= 1; 0 collects nothing). */
  maxItemsPerPeriod: number
  /** Allowed media types (e.g. ['image','video','text']); empty = any. */
  mediaTypes: string[]
}

/** Mutable per-period usage. Persisted alongside the Scout; rolled forward as
 *  periods elapse (mirroring the on-chain cumulative-resets-each-period rule). */
export interface BudgetUsage {
  /** Unix seconds marking the start of the current accounting period. */
  periodStart: number
  spentThisPeriod: string
  itemsThisPeriod: number
}

export interface Scout {
  id: string
  /** The user's Base Account address (lowercased). */
  owner: string
  name: string
  mode: ScoutMode
  status: ScoutStatus
  budget: ScoutBudget
  policy: ScoutPolicy
  /** Opaque reference to the granted Spend Permission (provider-specific). */
  permissionRef?: string
  createdAt: number
}

/** A discovery candidate the engine decides on. Price/currency are the
 *  authoritative on-chain sale values (resolved upstream by prepare-collect). */
export interface Candidate {
  collection: string
  tokenId: string
  creator?: string
  currency: Currency
  pricePerToken: string
  mediaType?: string
  name?: string
}

export type SkipReason =
  | 'paused'
  | 'permission-inactive'
  | 'currency-mismatch'
  | 'collection-blocked'
  | 'creator-blocked'
  | 'collection-not-allowed'
  | 'creator-not-allowed'
  | 'media-type-not-allowed'
  | 'already-collected'
  | 'over-item-price'
  | 'period-item-limit'
  | 'insufficient-budget'

export type Decision =
  | { action: 'collect'; candidate: Candidate; cost: string }
  | { action: 'skip'; candidate: Candidate; reason: SkipReason }

export interface RunPlan {
  decisions: Decision[]
  /** Candidates approved to collect, in input order, within budget + limits. */
  toCollect: Candidate[]
  /** Total cost of toCollect, base units. */
  projectedSpend: string
  projectedItems: number
  /** Usage after applying toCollect (what to persist if executed). */
  endUsage: BudgetUsage
}

// ───────────────────────── budget accounting ─────────────────────────

export function periodSecondsFromDays(days: number): number {
  return Math.max(1, Math.floor(days * 86_400))
}

export function isPermissionActive(b: ScoutBudget, now: number): boolean {
  return now >= b.start && now < b.end
}

/** Start of the period containing `now`, aligned to `start` + k·period — the
 *  same boundary math SpendPermissionManager uses to reset cumulative spend. */
export function periodStartFor(b: ScoutBudget, now: number): number {
  if (now <= b.start) return b.start
  const elapsed = now - b.start
  return b.start + Math.floor(elapsed / b.periodSeconds) * b.periodSeconds
}

export function freshUsage(b: ScoutBudget, now: number): BudgetUsage {
  return { periodStart: periodStartFor(b, now), spentThisPeriod: '0', itemsThisPeriod: 0 }
}

/** Roll usage forward if `now` is in a later period than it was last recorded:
 *  cumulative spend + item count reset at each period boundary. Idempotent. */
export function rollUsage(b: ScoutBudget, usage: BudgetUsage, now: number): BudgetUsage {
  const ps = periodStartFor(b, now)
  if (ps > usage.periodStart) {
    return { periodStart: ps, spentThisPeriod: '0', itemsThisPeriod: 0 }
  }
  return usage
}

/** Remaining spendable allowance in the current period (after any roll). */
export function remainingAllowance(b: ScoutBudget, usage: BudgetUsage, now: number): bigint {
  const rolled = rollUsage(b, usage, now)
  const rem = BigInt(b.allowance) - BigInt(rolled.spentThisPeriod)
  return rem > 0n ? rem : 0n
}

// ───────────────────────── policy decisions ─────────────────────────

const lc = (s: string | undefined): string => (s ?? '').toLowerCase()
const collectedKey = (collection: string, tokenId: string): string => `${lc(collection)}:${tokenId}`

/**
 * Decide whether a single candidate may be collected given the scout's policy
 * and current usage. The order is intentional: cheapest/most-decisive gates
 * first, budget last, so the skip reason is the most actionable one.
 */
export function evaluateCandidate(
  scout: Scout,
  candidate: Candidate,
  usage: BudgetUsage,
  now: number,
  alreadyCollected?: ReadonlySet<string>,
): Decision {
  const skip = (reason: SkipReason): Decision => ({ action: 'skip', candidate, reason })

  if (scout.status !== 'active') return skip('paused')
  if (!isPermissionActive(scout.budget, now)) return skip('permission-inactive')
  if (candidate.currency !== scout.budget.currency) return skip('currency-mismatch')

  const col = lc(candidate.collection)
  const cr = candidate.creator ? lc(candidate.creator) : undefined
  const p = scout.policy

  if (p.blockedCollections.map(lc).includes(col)) return skip('collection-blocked')
  if (cr && p.blockedCreators.map(lc).includes(cr)) return skip('creator-blocked')
  if (p.collections.length > 0 && !p.collections.map(lc).includes(col)) return skip('collection-not-allowed')
  if (p.creators.length > 0 && !(cr && p.creators.map(lc).includes(cr))) return skip('creator-not-allowed')
  if (p.mediaTypes.length > 0 && !(candidate.mediaType && p.mediaTypes.includes(candidate.mediaType))) {
    return skip('media-type-not-allowed')
  }
  if (alreadyCollected?.has(collectedKey(candidate.collection, candidate.tokenId))) {
    return skip('already-collected')
  }

  let price: bigint
  try {
    price = BigInt(candidate.pricePerToken)
  } catch {
    return skip('over-item-price') // unparseable price → refuse, fail-closed
  }
  if (price > BigInt(p.maxItemPrice)) return skip('over-item-price')

  const rolled = rollUsage(scout.budget, usage, now)
  if (rolled.itemsThisPeriod >= p.maxItemsPerPeriod) return skip('period-item-limit')
  if (price > BigInt(scout.budget.allowance) - BigInt(rolled.spentThisPeriod)) return skip('insufficient-budget')

  return { action: 'collect', candidate, cost: price.toString() }
}

/**
 * Plan a run over an ordered candidate list (the discovery ranking). Greedily
 * accepts candidates in order, accumulating spend + item count against the
 * rolled usage, so the per-period dollar cap AND item cap are honored ACROSS
 * the whole batch — later candidates correctly skip with insufficient-budget /
 * period-item-limit once a cap is reached. Dedupes within the batch.
 *
 * Used identically by Propose (show `toCollect`, user one-taps) and Auto
 * (execute `toCollect`, persist `endUsage`).
 */
export function planRun(
  scout: Scout,
  candidates: readonly Candidate[],
  usage: BudgetUsage,
  now: number,
  alreadyCollected?: ReadonlySet<string>,
): RunPlan {
  const base = rollUsage(scout.budget, usage, now)
  const seen = new Set<string>(alreadyCollected ? Array.from(alreadyCollected) : [])
  const decisions: Decision[] = []
  const toCollect: Candidate[] = []
  let spent = BigInt(base.spentThisPeriod)
  let items = base.itemsThisPeriod

  for (const candidate of candidates) {
    const working: BudgetUsage = {
      periodStart: base.periodStart,
      spentThisPeriod: spent.toString(),
      itemsThisPeriod: items,
    }
    const decision = evaluateCandidate(scout, candidate, working, now, seen)
    decisions.push(decision)
    if (decision.action === 'collect') {
      toCollect.push(candidate)
      spent += BigInt(decision.cost)
      items += 1
      seen.add(collectedKey(candidate.collection, candidate.tokenId))
    }
  }

  return {
    decisions,
    toCollect,
    projectedSpend: (spent - BigInt(base.spentThisPeriod)).toString(),
    projectedItems: items - base.itemsThisPeriod,
    endUsage: { periodStart: base.periodStart, spentThisPeriod: spent.toString(), itemsThisPeriod: items },
  }
}
