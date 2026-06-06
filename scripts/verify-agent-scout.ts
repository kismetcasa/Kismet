// Executing test for the Scout engine (lib/agent/scout/engine.ts).
//
// Unlike the calldata oracles (independent viem re-derivations), this runs the
// REAL engine via Node type-stripping — the engine is pure and import-free, so
// `node --experimental-strip-types` executes it directly. This is the safety-
// critical core of budgeted autonomy, so it gets real coverage.
//
// Run: node --experimental-strip-types scripts/verify-agent-scout.ts

import {
  type Scout,
  type ScoutBudget,
  type ScoutPolicy,
  type BudgetUsage,
  type Candidate,
  evaluateCandidate,
  planRun,
  rollUsage,
  remainingAllowance,
  periodStartFor,
  isPermissionActive,
  freshUsage,
} from '../lib/agent/scout/engine.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const NOW = 1_000_000
const DAY = 86_400
const COL = '0x00000000000000000000000000000000c011ec70'
const CRE = '0x00000000000000000000000000000000c4ea1009'

const baseBudget = (over: Partial<ScoutBudget> = {}): ScoutBudget => ({
  currency: 'usdc',
  allowance: '10000000', // 10 USDC
  periodSeconds: 7 * DAY,
  start: NOW - DAY,
  end: NOW + 365 * DAY,
  ...over,
})

const basePolicy = (over: Partial<ScoutPolicy> = {}): ScoutPolicy => ({
  collections: [],
  creators: [],
  blockedCollections: [],
  blockedCreators: [],
  maxItemPrice: '5000000', // 5 USDC
  maxItemsPerPeriod: 3,
  mediaTypes: [],
  ...over,
})

const mkScout = (over: { budget?: Partial<ScoutBudget>; policy?: Partial<ScoutPolicy>; status?: 'active' | 'paused'; mode?: 'auto' | 'propose' } = {}): Scout => ({
  id: 's1',
  owner: '0xowner',
  name: 'Test Scout',
  mode: over.mode ?? 'auto',
  status: over.status ?? 'active',
  budget: baseBudget(over.budget),
  policy: basePolicy(over.policy),
  createdAt: NOW - DAY,
})

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  collection: COL,
  tokenId: '1',
  creator: CRE,
  currency: 'usdc',
  pricePerToken: '2000000', // 2 USDC
  mediaType: 'image',
  ...over,
})

const usage = (over: Partial<BudgetUsage> = {}): BudgetUsage => ({
  periodStart: periodStartFor(baseBudget(), NOW),
  spentThisPeriod: '0',
  itemsThisPeriod: 0,
  ...over,
})

const reason = (s: Scout, c: Candidate, u: BudgetUsage, now = NOW, set?: Set<string>): string => {
  const d = evaluateCandidate(s, c, u, now, set)
  return d.action === 'skip' ? d.reason : 'collect'
}

console.log('budget accounting')
{
  const b = baseBudget({ start: 100, periodSeconds: 10 })
  check('periodStartFor aligns to start + k*period', periodStartFor(b, 135) === 130, String(periodStartFor(b, 135)))
  check('periodStartFor clamps before start', periodStartFor(b, 50) === 100)
  check('isPermissionActive true in window', isPermissionActive(baseBudget(), NOW))
  check('isPermissionActive false after end', !isPermissionActive(baseBudget({ end: NOW - 1 }), NOW))
  check('remainingAllowance mid-period (10 - 3 = 7)', remainingAllowance(baseBudget(), usage({ spentThisPeriod: '3000000' }), NOW) === 7000000n)
  // usage stamped in a previous period rolls to a fresh full allowance
  const old = usage({ periodStart: periodStartFor(baseBudget(), NOW) - 8 * DAY, spentThisPeriod: '9000000', itemsThisPeriod: 3 })
  const rolled = rollUsage(baseBudget(), old, NOW)
  check('rollUsage resets spend on a new period', rolled.spentThisPeriod === '0' && rolled.itemsThisPeriod === 0)
  check('remainingAllowance after roll is full allowance', remainingAllowance(baseBudget(), old, NOW) === 10000000n)
  check('freshUsage starts empty', freshUsage(baseBudget(), NOW).spentThisPeriod === '0')
}

console.log('\nevaluateCandidate — happy path')
{
  const d = evaluateCandidate(mkScout(), cand(), usage(), NOW)
  check('collects within policy + budget', d.action === 'collect' && d.cost === '2000000')
}

console.log('\nevaluateCandidate — skip reasons (order + correctness)')
{
  check('paused', reason(mkScout({ status: 'paused' }), cand(), usage()) === 'paused')
  check('permission-inactive (after end)', reason(mkScout({ budget: { end: NOW - 1 } }), cand(), usage()) === 'permission-inactive')
  check('currency-mismatch', reason(mkScout(), cand({ currency: 'eth' }), usage()) === 'currency-mismatch')
  check('collection-blocked', reason(mkScout({ policy: { blockedCollections: [COL] } }), cand(), usage()) === 'collection-blocked')
  check('creator-blocked', reason(mkScout({ policy: { blockedCreators: [CRE] } }), cand(), usage()) === 'creator-blocked')
  check('collection-not-allowed', reason(mkScout({ policy: { collections: ['0xdead'] } }), cand(), usage()) === 'collection-not-allowed')
  check('creator-not-allowed', reason(mkScout({ policy: { creators: ['0xdead'] } }), cand(), usage()) === 'creator-not-allowed')
  check('media-type-not-allowed', reason(mkScout({ policy: { mediaTypes: ['video'] } }), cand({ mediaType: 'image' }), usage()) === 'media-type-not-allowed')
  check('already-collected', reason(mkScout(), cand(), usage(), NOW, new Set([`${COL}:1`])) === 'already-collected')
  check('over-item-price (6 > 5)', reason(mkScout(), cand({ pricePerToken: '6000000' }), usage()) === 'over-item-price')
  check('over-item-price (unparseable)', reason(mkScout(), cand({ pricePerToken: 'NaN' }), usage()) === 'over-item-price')
  check('period-item-limit (at cap)', reason(mkScout({ policy: { maxItemsPerPeriod: 3 } }), cand(), usage({ itemsThisPeriod: 3 })) === 'period-item-limit')
  check('insufficient-budget (rem 1 < price 2)', reason(mkScout(), cand(), usage({ spentThisPeriod: '9000000' })) === 'insufficient-budget')
  // allowlist match (positive)
  check('collection allowlist match collects', evaluateCandidate(mkScout({ policy: { collections: [COL.toUpperCase()] } }), cand(), usage(), NOW).action === 'collect')
}

console.log('\nplanRun — accumulation honors caps across the basket')
{
  const candidates = [
    cand({ tokenId: '1', pricePerToken: '4000000' }),
    cand({ tokenId: '2', pricePerToken: '4000000' }),
    cand({ tokenId: '3', pricePerToken: '4000000' }),
  ]
  const plan = planRun(mkScout({ policy: { maxItemsPerPeriod: 10 } }), candidates, usage(), NOW)
  check('budget cap: collect 2 of 3 (8 of 10 USDC)', plan.toCollect.length === 2)
  check('3rd skips insufficient-budget', plan.decisions[2].action === 'skip' && plan.decisions[2].reason === 'insufficient-budget')
  check('projectedSpend = 8 USDC', plan.projectedSpend === '8000000')
  check('endUsage spent/items updated', plan.endUsage.spentThisPeriod === '8000000' && plan.endUsage.itemsThisPeriod === 2)
}
{
  const candidates = [cand({ tokenId: '1', pricePerToken: '1000000' }), cand({ tokenId: '2', pricePerToken: '1000000' }), cand({ tokenId: '3', pricePerToken: '1000000' })]
  const plan = planRun(mkScout({ policy: { maxItemsPerPeriod: 2 } }), candidates, usage(), NOW)
  check('item cap: collect 2, 3rd skips period-item-limit', plan.toCollect.length === 2 && plan.decisions[2].action === 'skip' && plan.decisions[2].reason === 'period-item-limit')
}
{
  const dup = cand({ tokenId: '7', pricePerToken: '1000000' })
  const plan = planRun(mkScout(), [dup, { ...dup }], usage(), NOW)
  check('dedupe within batch: 2nd identical skips already-collected', plan.toCollect.length === 1 && plan.decisions[1].action === 'skip' && plan.decisions[1].reason === 'already-collected')
}

console.log(`\n${failures === 0 ? 'OK — scout engine: all assertions passed' : `FAILED — ${failures} assertion(s)`}`)
process.exit(failures === 0 ? 0 : 1)
