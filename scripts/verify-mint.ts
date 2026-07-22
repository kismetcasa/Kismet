// Verifies the mint flow's pure, load-bearing invariants in CI so a regression
// goes red on the PR instead of reverting a real mint:
//   1. Splits-allocation math always emits INTEGER percentAllocation summing to
//      EXACTLY the target (guards the historical decimal-47.5 SplitMain revert).
//   2. The EIP-712 mint-intent message carries EXACTLY the typed-schema fields
//      (drift here silently breaks signature verification / the inprocess body).
//
// Run: node --experimental-strip-types scripts/verify-mint.ts

import { roundToIntegerAllocations, computeFinalSplits, type Split } from '../lib/splitsMath.ts'
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

// ── 1a. roundToIntegerAllocations: integers, each >= 1, summing to target ──
const roundCases: Array<{ v: number[]; t: number }> = [
  { v: [80, 20], t: 100 },
  { v: [47.5, 47.5], t: 95 }, // the literal 47.5 decimals that reverted on-chain
  { v: [33.33, 33.33, 33.34], t: 100 },
  { v: [99, 1], t: 100 },
  { v: [0.5, 0.5, 94], t: 95 }, // skewed: tiny + large
  { v: [50, 50], t: 100 },
]
for (const { v, t } of roundCases) {
  const out = roundToIntegerAllocations(v, t)
  const tag = `${JSON.stringify(v)}->${t}`
  check(`round ${tag}: integers`, isInts(out), JSON.stringify(out))
  check(`round ${tag}: sum==${t}`, total(out) === t, `got ${total(out)}`)
  check(`round ${tag}: all>=1`, out.every((x) => x >= 1), JSON.stringify(out))
}

// ── 1b. computeFinalSplits: every path emits integers summing to EXACTLY 100 ──
const c2: Split[] = [{ address: A, percentAllocation: 80 }, { address: B, percentAllocation: 20 }]
const c5050: Split[] = [{ address: A, percentAllocation: 50 }, { address: B, percentAllocation: 50 }]

check('finalSplits: residencies off + 1 custom -> undefined',
  computeFinalSplits([{ address: A, percentAllocation: 100 }], false, 5, CREATOR, RES) === undefined)

const off2 = computeFinalSplits(c2, false, 5, CREATOR, RES)
check('finalSplits: off+2 integers/sum100/sorted',
  !!off2 && isInts(pcts(off2)) && total(pcts(off2)) === 100 && sortedAsc(off2), JSON.stringify(off2))

const on0 = computeFinalSplits([], true, 5, CREATOR, RES)
check('finalSplits: on+0 -> [creator 95, residencies 5], sum100',
  !!on0 && total(pcts(on0)) === 100 && on0.some((s) => s.address.toLowerCase() === RES && s.percentAllocation === 5),
  JSON.stringify(on0))

const on2 = computeFinalSplits(c5050, true, 5, CREATOR, RES) // the 50/50 x 0.95 = 47.5 path
check('finalSplits: on+2 (47.5 guard) integers/sum100/sorted',
  !!on2 && isInts(pcts(on2)) && total(pcts(on2)) === 100 && sortedAsc(on2), JSON.stringify(on2))
check('finalSplits: on+2 keeps residencies = 5%',
  !!on2 && on2.some((s) => s.address.toLowerCase() === RES && s.percentAllocation === 5))

// ── 1c. UI absorb-contract pins — the mint form's SplitsEditor composes
// [custom rows + derived creator remainder] and renders these EXACT integers
// as its "mints as" preview, so the rounding tie-break order is load-bearing
// display behavior, not math trivia. Pinned so a rounding-order change goes
// red here instead of silently re-ordering artists' payouts vs the preview.
const byAddr = (s: Split[] | undefined, a: string): number | undefined =>
  s?.find((x) => x.address.toLowerCase() === a)?.percentAllocation
const absorb2080 = computeFinalSplits(
  [{ address: A, percentAllocation: 20 }, { address: CREATOR, percentAllocation: 80 }],
  true, 5, CREATOR, RES)
check('finalSplits pin: [A 20, creator 80] + res5 -> A 19 / creator 76 / res 5',
  byAddr(absorb2080, A) === 19 && byAddr(absorb2080, CREATOR) === 76 && byAddr(absorb2080, RES) === 5,
  JSON.stringify(absorb2080))
const pin5050 = computeFinalSplits(c5050, true, 5, CREATOR, RES)
check('finalSplits pin: [A 50, B 50] + res5 -> A 47 / B 48 / res 5 (later-added gets the point)',
  byAddr(pin5050, A) === 47 && byAddr(pin5050, B) === 48 && byAddr(pin5050, RES) === 5,
  JSON.stringify(pin5050))

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
