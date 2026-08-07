// Verifies the pinned-showcase ordering core (lib/showcaseOrder) in CI so a
// regression goes red on the PR instead of silently scrambling profiles.
// What this pins down:
//   1. orderByPins (curated showcase): pinned-only filter in pin-recency
//      order, unknown/stale refs drop away, empty pin set renders nothing —
//      the rules that make the curated view self-validating.
//   2. pinsFirst (visitor-facing full profile): EVERY item exactly once,
//      pinned items floated first in pin-recency order, the remainder in its
//      incoming order (stable partition, not a sort) — the "10 mints, 4
//      pinned → the 4 pins are the first 4" contract. Stale refs are inert;
//      no pins (or none loaded) returns the array unchanged.
//   3. isPublicViewMode accepts exactly the two modes the pins payload /
//      public-view route may carry.
//   4. derivePublicViewMode — the never-chose default policy: pins present →
//      'curated' (grandfathered showcase-era pinners keep their curation),
//      no pins → 'full' (new profiles are browsable out of the box).
//
// Run: node --experimental-strip-types scripts/verify-showcase-order.ts

import { derivePublicViewMode, isPublicViewMode, MAX_PINS_PER_CATEGORY, orderByPins, pinsFirst } from '../lib/showcaseOrder.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

interface Item { key: string; label: string }
const item = (key: string): Item => ({ key, label: `item-${key}` })
const keys = (items: Item[]) => items.map((i) => i.key).join(',')
const keyOf = (i: Item) => i.key

// A profile feed: newest-minted first, keys a..j (10 mints).
const feed = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(item)
// Pins as the API serves them: newest-PINNED first. Deliberately not in feed
// order (h pinned last, then c, f, a) and including one stale ref (zz) for a
// moment outside the loaded window.
const pinOrder = ['h', 'c', 'f', 'a', 'zz']

// ── 1. orderByPins — curated showcase ───────────────────────────────────────
check('orderByPins: pinned only, pin-recency order', keys(orderByPins(feed, keyOf, pinOrder)) === 'h,c,f,a')
check('orderByPins: empty pin set -> empty showcase', orderByPins(feed, keyOf, []).length === 0)
check('orderByPins: only stale refs -> empty showcase', orderByPins(feed, keyOf, ['zz', 'yy']).length === 0)
check('orderByPins: does not mutate the feed', keys(feed) === 'a,b,c,d,e,f,g,h,i,j')

// ── 2. pinsFirst — full profile, pins floated first ─────────────────────────
const full = pinsFirst(feed, keyOf, pinOrder)
check('pinsFirst: pins are the first 4, pin-recency order', keys(full.slice(0, 4)) === 'h,c,f,a')
check('pinsFirst: remainder keeps feed order', keys(full.slice(4)) === 'b,d,e,g,i,j')
check('pinsFirst: every item exactly once', full.length === feed.length && new Set(full.map(keyOf)).size === feed.length)
check('pinsFirst: stale pin refs are inert', keys(pinsFirst(feed, keyOf, ['zz'])) === keys(feed))
check('pinsFirst: no pins -> identity (same array back)', pinsFirst(feed, keyOf, []) === feed)
check('pinsFirst: all items pinned -> pure pin order', keys(pinsFirst(feed.slice(0, 3), keyOf, ['c', 'a', 'b'])) === 'c,a,b')
check('pinsFirst: does not mutate the feed', keys(feed) === 'a,b,c,d,e,f,g,h,i,j')

// The user-visible contract verbatim: 10 mints, 4 pinned — the 4 pinned show
// as the first 4, the other 6 exactly as the feed ordered them.
const ten = pinsFirst(feed, keyOf, ['j', 'e', 'b', 'g'])
check('pinsFirst: 10 mints / 4 pins contract', keys(ten) === 'j,e,b,g,a,c,d,f,h,i')

// ── 3. isPublicViewMode ─────────────────────────────────────────────────────
check("isPublicViewMode: accepts 'curated'", isPublicViewMode('curated'))
check("isPublicViewMode: accepts 'full'", isPublicViewMode('full'))
check('isPublicViewMode: rejects other strings', !isPublicViewMode('showcase') && !isPublicViewMode(''))
check('isPublicViewMode: rejects non-strings', !isPublicViewMode(undefined) && !isPublicViewMode(null) && !isPublicViewMode(1))

// ── 4. derivePublicViewMode — unset-profile default policy ──────────────────
check("derive: pinned profile (grandfathered) -> 'curated'", derivePublicViewMode(true) === 'curated')
check("derive: pinless profile -> 'full' (the new default)", derivePublicViewMode(false) === 'full')

// ── 5. the per-category cap ─────────────────────────────────────────────────
// The product decision (6 — two full showcase rows on lg+, one full row of
// the six-column dense grid) plus a cap-width ordering pass so the widest
// legal pin set exercises both orderers.
check('MAX_PINS_PER_CATEGORY is 6', MAX_PINS_PER_CATEGORY === 6)
const sixPins = ['j', 'e', 'b', 'g', 'a', 'd']
check('orderByPins at cap width', keys(orderByPins(feed, keyOf, sixPins)) === 'j,e,b,g,a,d')
const fullSix = pinsFirst(feed, keyOf, sixPins)
check('pinsFirst at cap width: pins are the first 6, pin order', keys(fullSix.slice(0, 6)) === 'j,e,b,g,a,d')
check('pinsFirst at cap width: remainder keeps feed order', keys(fullSix.slice(6)) === 'c,f,h,i')

if (failures > 0) {
  console.error(`\nverify-showcase-order: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify-showcase-order: all checks passed')
