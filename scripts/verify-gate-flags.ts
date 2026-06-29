// Guards lib/gateFlags.isFlagSet — the Upstash flag normalizer for the gate
// (kismetart:gate:enabled) and the platform kill-switch (:platform:paused).
//
// THE REGRESSION IT GUARDS: Upstash's REST client SETs '1' as a string but its
// GET JSON-parses it back to the NUMBER 1, so a strict `=== '1'` reads a SET
// flag as false — the enable/pause toggle silently never persists. That shipped
// to production once ("Fix platform-paused/gate flags not persisting",
// 2026-05-24). Both representations must read true, every unset form must read
// false, so the normalization can't quietly regress.
//
// Run: node --experimental-strip-types scripts/verify-gate-flags.ts

import { isFlagSet } from '../lib/gateFlags.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

// SET — both the written string form and the JSON-parsed numeric form.
check("'1' (SET form) → set", isFlagSet('1') === true)
check('1 (Upstash GET form) → set', isFlagSet(1) === true)

// UNSET — every "not set" representation reads false.
check("'0' → unset", isFlagSet('0') === false)
check('0 → unset', isFlagSet(0) === false)
check('null → unset', isFlagSet(null) === false)
check('undefined → unset', isFlagSet(undefined) === false)
check("'' → unset", isFlagSet('') === false)
check("'true' → unset (not the encoding)", isFlagSet('true') === false)

if (failures > 0) {
  console.error(`\n${failures} gate-flag check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll gate-flag checks passed.')
