// CI-locks the off-platform admission rule (lib/feedAdmission) the timeline
// route's scope=standalone filter applies to created-mints NON-members:
//   - the epoch boundary is inclusive and pinned to 2026-08-01T00:00:00Z —
//     moving it silently re-admits (earlier) or re-hides (later) real
//     moments, so a change must be deliberate and go red here first;
//   - both created_at shapes In Process actually emits ("+00:00" offset and
//     millisecond "Z") classify identically;
//   - absent/garbage created_at fails CLOSED (excluded), matching the
//     fail-closed contract of the other browse filters.
//
// Run: node --experimental-strip-types scripts/verify-feed-admission.ts

import { admitsOffPlatformMint, OFFPLATFORM_ADMISSION_EPOCH_MS } from '../lib/feedAdmission.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// The epoch itself is a pinned product decision, not an implementation detail.
check('epoch is 2026-08-01T00:00:00Z',
  OFFPLATFORM_ADMISSION_EPOCH_MS === Date.parse('2026-08-01T00:00:00Z'),
  String(OFFPLATFORM_ADMISSION_EPOCH_MS))

// Inclusive boundary: a mint AT the epoch instant is admitted.
check('boundary: exact epoch instant admits', admitsOffPlatformMint('2026-08-01T00:00:00Z'))
check('boundary: 1ms before epoch excludes', !admitsOffPlatformMint('2026-07-31T23:59:59.999Z'))

// The two timestamp shapes observed in production In Process /timeline rows
// (offset-form and millisecond-Z-form) must classify identically.
check('offset-form post-epoch admits (the 0x4dd7…:2 incident shape)',
  admitsOffPlatformMint('2026-08-09T11:30:25+00:00'))
check('ms-Z-form post-epoch admits', admitsOffPlatformMint('2026-08-09T11:30:25.279Z'))
check('offset-form pre-epoch excludes', !admitsOffPlatformMint('2026-05-10T10:52:22+00:00'))
check('ms-Z-form pre-epoch excludes', !admitsOffPlatformMint('2026-07-30T07:15:34.279Z'))

// Fail-closed on anything unusable.
check('absent created_at excludes', !admitsOffPlatformMint(undefined))
check('null created_at excludes', !admitsOffPlatformMint(null))
check('empty created_at excludes', !admitsOffPlatformMint(''))
check('garbage created_at excludes', !admitsOffPlatformMint('not-a-date'))

// Far-future timestamps admit (a fresh mint with clock skew must not vanish).
check('future created_at admits', admitsOffPlatformMint('2027-01-01T00:00:00Z'))

if (failures > 0) {
  console.error(`\n${failures} feed-admission check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll feed-admission checks passed.')
