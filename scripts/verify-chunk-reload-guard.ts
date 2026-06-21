// Verifies the critical-op guard in lib/chunkReload.ts.
//
// THE BUG IT GUARDS: a media mint streams its bytes straight to Turbo (credits
// already spent) while the large upload saturates the client uplink. That
// stalls background route-prefetch chunk downloads, which webpack surfaces as a
// ChunkLoadError indistinguishable from a stale deploy — so the self-heal used
// to reload the page MID-MINT, aborting the (paid) upload and dropping the user
// onto a load the saturated connection couldn't serve ("site can't be reached").
//
// This exercises the REAL production module (not a copy): while a mint/deploy
// is in flight (beginCriticalOp), a chunk error must NOT reload; outside one,
// stale-deploy recovery must still reload. Browser globals are mocked because
// the module reads them at call time, so no DOM/network is needed.
//
// Run: node --experimental-strip-types scripts/verify-chunk-reload-guard.ts

import { reloadOnceForChunkError, beginCriticalOp, endCriticalOp } from '../lib/chunkReload.ts'

let reloadCount = 0
const store = new Map<string, string>()

// The module references bare `window` / `sessionStorage`, which resolve through
// globalThis — install minimal mocks before any call.
;(globalThis as unknown as { window: unknown }).window = {
  location: { reload: () => { reloadCount += 1 } },
}
;(globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
}

let failures = 0
function check(cond: boolean, msg: string): void {
  if (cond) console.log('  PASS  ' + msg)
  else { console.error('  FAIL  ' + msg); failures += 1 }
}

// 1. Idle → stale-deploy recovery still works (reloads once, returns true).
store.clear(); reloadCount = 0
check(reloadOnceForChunkError() === true && reloadCount === 1, 'idle chunk error reloads once')

// 2. Mint/deploy in flight → reload SUPPRESSED (returns false so the caller
//    paints a non-destructive manual-reload notice instead of nuking the mint).
store.clear(); reloadCount = 0
beginCriticalOp()
check(reloadOnceForChunkError() === false && reloadCount === 0, 'critical op in flight suppresses reload')

// 3. Overlapping ops (e.g. deploy + mint): one end() still leaves depth > 0.
store.clear(); reloadCount = 0
beginCriticalOp()            // depth 2
endCriticalOp()             // depth 1
check(reloadOnceForChunkError() === false && reloadCount === 0, 'nested op, one end still suppresses')

// 4. Balanced ends → recovery re-enabled for the idle case.
store.clear(); reloadCount = 0
endCriticalOp()             // depth 0
check(reloadOnceForChunkError() === true && reloadCount === 1, 'all ops ended reloads again')

// 5. An unbalanced end() is clamped at 0 — it can't drive depth negative and
//    permanently suppress recovery.
store.clear(); reloadCount = 0
endCriticalOp(); endCriticalOp()
check(reloadOnceForChunkError() === true && reloadCount === 1, 'over-end clamped, recovery intact')

if (failures > 0) { console.error('\n' + failures + ' check(s) FAILED'); process.exit(1) }
console.log('\nAll chunk-reload guard checks passed.')
