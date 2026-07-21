// CI-locks the collections-feed ordering invariants behind the edit-bump fix
// (collectionFeedOrderTs): a stored createdAt pin outranks inprocess's
// created_at (which its indexer rewrites on contractURI edits), backfill pins
// are offered only when a meta record already exists, and missing/malformed
// dates float to the top (indexer-lag UX) instead of NaN-poisoning the sort.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//        --experimental-strip-types --import ./scripts/register-ts-alias.mjs \
//        scripts/verify-collection-rank.ts

import { collectionFeedOrderTs } from '../lib/kv.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const ISO = '2026-07-01T00:00:00.000Z'
const ISO_MS = new Date(ISO).getTime()
const PIN = 1_750_000_000_000 // an earlier deploy-time pin (ms)

// ── pin outranks the feed timestamp (the edit-bump defense) ──
let r = collectionFeedOrderTs({ createdAt: PIN }, ISO)
check('pin wins over a differing created_at', r.ts === PIN && r.backfillTs === null)
r = collectionFeedOrderTs({ createdAt: PIN }, undefined)
check('pin wins with no created_at at all', r.ts === PIN && r.backfillTs === null)

// ── no pin: feed timestamp ranks; backfill only with an existing meta ──
r = collectionFeedOrderTs({}, ISO)
check('meta without pin → ranks by created_at', r.ts === ISO_MS)
check('meta without pin → offers backfill', r.backfillTs === ISO_MS)
r = collectionFeedOrderTs(undefined, ISO)
check('NO meta record → ranks by created_at', r.ts === ISO_MS)
check('NO meta record → never synthesizes a backfill', r.backfillTs === null)

// ── missing/malformed dates float to the top, never NaN ──
r = collectionFeedOrderTs(undefined, undefined)
check('no data at all → Infinity float', r.ts === Number.POSITIVE_INFINITY && r.backfillTs === null)
r = collectionFeedOrderTs({}, 'not-a-date')
check('malformed created_at → Infinity float, no backfill',
  r.ts === Number.POSITIVE_INFINITY && r.backfillTs === null)

// ── degenerate pin values are treated as absent ──
r = collectionFeedOrderTs({ createdAt: 0 }, ISO)
check('pin=0 treated as absent (falls to created_at)', r.ts === ISO_MS && r.backfillTs === ISO_MS)
r = collectionFeedOrderTs({ createdAt: Number.NaN }, ISO)
check('pin=NaN treated as absent', r.ts === ISO_MS && r.backfillTs === ISO_MS)

console.log(failures === 0 ? '\nAll collection-rank checks passed.' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
