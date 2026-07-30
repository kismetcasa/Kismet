// Guards lib/passUnion — the pure planning/parsing layer under the Pass
// gate's identity union (expandToGateWallets → hasGateAccess /
// /api/pass-validity?scope=identity).
//
// THE REGRESSIONS IT GUARDS:
//   1. planUnionCheck ordering/dedup/cap — the caller MUST stay first (the
//      gate checks it before any sibling and the identity route's blacklist
//      loop relies on it being present), dedup must be case-insensitive
//      (mixed-checksum sibling lists would double-check wallets), and the
//      cap must bound the per-request fan-out (each surviving wallet can
//      cost a full hasValidPass: Redis reads + one balanceOfBatch RPC).
//   2. parseLedgerBalance dual representation — Upstash SETs '1' as a string
//      but GET JSON-parses it back to the NUMBER 1 (the exact bug class
//      verify-gate-flags.ts pins for the enable flag). Both forms must read
//      as the same balance, negatives must clamp to 0 (out-of-order webhook
//      decrements), and garbage must read 0 — a NaN here would make the
//      union prefilter drop a legitimately credited wallet.
//
// Run: node --experimental-strip-types scripts/verify-pass-union.ts

import { MAX_UNION_WALLETS, planUnionCheck, parseLedgerBalance } from '../lib/passUnion.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const eq = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])

// --- planUnionCheck -------------------------------------------------------

check(
  'lowercases and keeps caller first',
  eq(planUnionCheck(['0xAbC', '0xDEF']), ['0xabc', '0xdef']),
)
check(
  'dedupes case-insensitively, first-seen order',
  eq(planUnionCheck(['0xabc', '0xABC', '0xdef', '0xabc']), ['0xabc', '0xdef']),
)
check(
  'drops null/undefined/empty entries',
  eq(planUnionCheck(['0xabc', null, undefined, '', '0xdef']), ['0xabc', '0xdef']),
)
check('empty input → empty plan', eq(planUnionCheck([]), []))
check('all-empty input → empty plan', eq(planUnionCheck([null, undefined, '']), []))

const oversized = Array.from({ length: MAX_UNION_WALLETS + 5 }, (_, i) => `0x${i}`)
const capped = planUnionCheck(oversized)
check(`caps at MAX_UNION_WALLETS (${MAX_UNION_WALLETS})`, capped.length === MAX_UNION_WALLETS)
check('cap keeps the caller (first entry) and preserves order', eq(capped, oversized.slice(0, MAX_UNION_WALLETS).map((a) => a.toLowerCase())))
check(
  'duplicates do not consume cap slots',
  planUnionCheck(['0xa', '0xA', ...oversized]).length === MAX_UNION_WALLETS,
)

// --- parseLedgerBalance ---------------------------------------------------

// Upstash dual representation: SET string form and GET numeric form must agree.
check("'1' (SET form) → 1", parseLedgerBalance('1') === 1)
check('1 (Upstash GET form) → 1', parseLedgerBalance(1) === 1)
check("'2' → 2", parseLedgerBalance('2') === 2)

// Unset / zero forms.
check('null → 0', parseLedgerBalance(null) === 0)
check('undefined → 0', parseLedgerBalance(undefined) === 0)
check("'0' → 0", parseLedgerBalance('0') === 0)
check('0 → 0', parseLedgerBalance(0) === 0)

// Clamp: stored value may briefly be negative from out-of-order webhook
// events; callers must never see negatives.
check('-3 clamps to 0', parseLedgerBalance(-3) === 0)
check("'-3' clamps to 0", parseLedgerBalance('-3') === 0)

// Garbage never becomes NaN (NaN > 0 is false, but NaN would also poison any
// arithmetic a caller does with the value — pin it to 0 outright).
check("'garbage' → 0", parseLedgerBalance('garbage') === 0)
check("'' → 0", parseLedgerBalance('') === 0)

if (failures > 0) {
  console.error(`\n${failures} pass-union check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll pass-union checks passed.')
