// Verifies the mint flow's pure, load-bearing invariants in CI so a regression
// goes red on the PR instead of reverting a real mint:
//   1. Splits-allocation math always emits INTEGER percentAllocation summing to
//      EXACTLY the target (guards the historical decimal-47.5 SplitMain revert).
//   2. The EIP-712 mint-intent message carries EXACTLY the typed-schema fields
//      (drift here silently breaks signature verification / the inprocess body).
//
// Run: node --experimental-strip-types scripts/verify-mint.ts

import { computeFinalSplits, type Split } from '../lib/splitsMath.ts'
import { buildMintIntent, MINT_INTENT_TYPES, type MintBody } from '../lib/intent.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const CREATOR = '0x0000000000000000000000000000000000000c0a'
const RES = '0x00000000000000000000000000000000000000e5'
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'

const isInts = (xs: number[]): boolean => xs.every((x) => Number.isInteger(x))
const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
const pcts = (s: Split[]): number[] => s.map((x) => x.percentAllocation)
const sortedAsc = (s: Split[]): boolean =>
  s.every((x, i) => i === 0 || s[i - 1].address.toLowerCase() <= x.address.toLowerCase())
const byAddr = (s: Split[] | undefined, a: string): number | undefined =>
  s?.find((x) => x.address.toLowerCase() === a.toLowerCase())?.percentAllocation

// ── 1. computeFinalSplits (subtraction model) ──────────────────────────────
// Collaborators receive EXACTLY the percent typed; residencies (when on) comes
// out of the CREATOR's share; the creator receives the remainder. Every path
// emits whole percents summing to EXACTLY 100 with no rounding — so the mint
// form's rows are byte-for-byte what mints. These pins lock that contract:
// a change would silently re-route real payouts.
const c2: Split[] = [{ address: A, percentAllocation: 80 }, { address: B, percentAllocation: 20 }]

// No collaborators, residencies off → creator keeps 100% → payoutRecipient path.
check('finalSplits: no collaborators + residencies off -> undefined',
  computeFinalSplits([], false, 5, CREATOR, RES) === undefined)

// Lone collaborator at 100%, residencies off → <2 recipients → undefined
// (the form blocks this state; the pure fn just declines to build a 1-way split).
check('finalSplits: lone collaborator 100% + off -> undefined',
  computeFinalSplits([{ address: A, percentAllocation: 100 }], false, 5, CREATOR, RES) === undefined)

// Two collaborators summing to 100, residencies off → give-it-all-away: exactly
// those two, creator absent, integers/sum100/sorted.
const off2 = computeFinalSplits(c2, false, 5, CREATOR, RES)
check('finalSplits: off + collaborators==100 -> those two, creator absent, sum100/sorted',
  !!off2 && off2.length === 2 && byAddr(off2, A) === 80 && byAddr(off2, B) === 20 &&
  isInts(pcts(off2)) && total(pcts(off2)) === 100 && sortedAsc(off2), JSON.stringify(off2))

// No collaborators, residencies on → [creator 100−p, residencies p].
const on0 = computeFinalSplits([], true, 5, CREATOR, RES)
check('finalSplits: no collaborators + residencies on -> creator 95 / residencies 5',
  byAddr(on0, CREATOR) === 95 && byAddr(on0, RES) === 5 && !!on0 && total(pcts(on0)) === 100,
  JSON.stringify(on0))

// THE headline case: one collaborator at 20%, residencies 5% → collaborator
// keeps EXACTLY 20, residencies 5, creator 75 (not 76 — no scaling). This is
// the "show 75%" the you-row displays.
const one20 = computeFinalSplits([{ address: A, percentAllocation: 20 }], true, 5, CREATOR, RES)
check('finalSplits: [A 20] + res5 -> A 20 / you 75 / res 5 (collaborator exact, no scaling)',
  byAddr(one20, A) === 20 && byAddr(one20, CREATOR) === 75 && byAddr(one20, RES) === 5 &&
  !!one20 && total(pcts(one20)) === 100 && sortedAsc(one20), JSON.stringify(one20))

// Two collaborators + residencies: both kept exact, creator absorbs the cut.
const two = computeFinalSplits(
  [{ address: A, percentAllocation: 50 }, { address: B, percentAllocation: 40 }], true, 5, CREATOR, RES)
check('finalSplits: [A 50, B 40] + res5 -> A 50 / B 40 / you 5 / res 5',
  byAddr(two, A) === 50 && byAddr(two, B) === 40 && byAddr(two, CREATOR) === 5 && byAddr(two, RES) === 5 &&
  !!two && total(pcts(two)) === 100 && sortedAsc(two), JSON.stringify(two))

// Collaborators claim everything below residencies → creator omitted (0 share),
// array is collaborator + residencies, still sums to 100.
const give = computeFinalSplits([{ address: A, percentAllocation: 95 }], true, 5, CREATOR, RES)
check('finalSplits: [A 95] + res5 -> A 95 / res 5, creator omitted, sum100',
  byAddr(give, A) === 95 && byAddr(give, RES) === 5 && byAddr(give, CREATOR) === undefined &&
  !!give && give.length === 2 && total(pcts(give)) === 100, JSON.stringify(give))

// ── 2. mint-intent message must carry EXACTLY the EIP-712 schema fields ──
const body: MintBody = {
  account: CREATOR,
  contract: { address: A },
  token: {
    tokenMetadataURI: 'ar://meta',
    salesConfig: { type: 'fixedPrice', pricePerToken: '44000000000000000', saleStart: '0', saleEnd: '100' },
    mintToCreatorCount: 0,
    maxSupply: 100,
  },
  splits: c2,
}
const msg = buildMintIntent(body, 'mint', 'nonce-1', 1_700_000_000)
const schemaFields = MINT_INTENT_TYPES.MintIntent.map((f) => f.name).sort()
const msgFields = Object.keys(msg).sort()
check('intent: message keys === EIP-712 schema fields (no drift)',
  JSON.stringify(msgFields) === JSON.stringify(schemaFields),
  `msg=${JSON.stringify(msgFields)} schema=${JSON.stringify(schemaFields)}`)

const msgReordered = buildMintIntent({ ...body, splits: [c2[1], c2[0]] }, 'mint', 'nonce-1', 1_700_000_000)
check('intent: splitsHash is order-independent (canonical sort)',
  msg.splitsHash === msgReordered.splitsHash, `${msg.splitsHash} vs ${msgReordered.splitsHash}`)
check('intent: no splits -> empty splitsHash',
  buildMintIntent({ ...body, splits: undefined }, 'mint', 'n', 1).splitsHash === '')

if (failures > 0) {
  console.error(`\n${failures} mint-flow check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll mint-flow checks passed.')
