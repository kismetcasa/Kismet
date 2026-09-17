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
//   3b. unreachablePins + parsePinRef — the rule behind the owner's
//      "pinned, but not shown here" strip, which is the ONLY unpin surface for
//      a ref whose card the section can't render (a sold listing, an artwork
//      sold on, anything past the un-paginated fetch window).
//   4. derivePublicViewMode — the never-chose default policy: pins present →
//      'curated' (grandfathered showcase-era pinners keep their curation),
//      no pins → 'full' (new profiles are browsable out of the box).
//   5. visibleToPublic — the public view (owner preview included) renders
//      only rows a visitor's server-filtered payload would carry: `hidden`-
//      flagged rows drop BEFORE any ordering/slicing, so the recent-mints
//      fallback backfills with the next visible mint and a pinned-but-hidden
//      ref falls away like a stale one.
//   6. normalizeHiddenFlag — the producer side of that same contract: the
//      API owns `hidden`, setting it from Kismet's hide sets alone and
//      stripping any value the upstream feed smuggled in. Regression-pins
//      the incident where a stray upstream `hidden: true` on a VISIBLE mint
//      blanked it out of public profiles once visibleToPublic trusted it.
//
// Run: node --experimental-strip-types scripts/verify-showcase-order.ts

import { derivePublicViewMode, isPublicViewMode, MAX_PINS_PER_CATEGORY, normalizeHiddenFlag, orderByPins, parsePinRef, pinsFirst, unreachablePins, visibleToPublic } from '../lib/showcaseOrder.ts'

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

// ── 5. visibleToPublic — hidden rows never reach a public surface ───────────
// The owner's payload carries their own hidden content flagged `hidden: true`
// (timeline: creator's own feed; listings: seller-scope own view) so the
// dashboard can badge it; a visitor's payload arrives with those rows already
// dropped server-side. The public view — including the owner's in-place
// preview — must render the owner's arrays down to the visitor set.
interface Row { key: string; hidden?: boolean }
const rowKeys = (rows: Row[]) => rows.map((r) => r.key).join(',')
const ownerFeed: Row[] = [
  { key: 'a' }, { key: 'b', hidden: true }, { key: 'c' }, { key: 'd', hidden: true }, { key: 'e' },
]
check('visibleToPublic: drops flagged rows, keeps order', rowKeys(visibleToPublic(ownerFeed)) === 'a,c,e')
check('visibleToPublic: does not mutate the input', rowKeys(ownerFeed) === 'a,b,c,d,e')
const visitorFeed: Row[] = [{ key: 'a' }, { key: 'c' }]
check('visibleToPublic: pre-filtered payload -> identity (same array back)', visibleToPublic(visitorFeed) === visitorFeed)
check('visibleToPublic: empty -> empty', visibleToPublic([]).length === 0)
// The reported bug verbatim: curated mode, nothing pinned → the fallback
// slices the most-recent mints. Filtering must precede the slice so the
// owner's preview slice equals a visitor's slice of their pre-filtered feed
// (hidden newest mint drops, next visible one backfills, count matches).
check(
  'fallback contract: filter THEN slice matches the visitor slice',
  rowKeys(visibleToPublic(ownerFeed).slice(0, 2)) === 'a,c',
)
// Composition with the orderers: a pinned-but-hidden ref behaves exactly
// like a stale ref — absent from the curated showcase, inert in pins-first.
check(
  'orderByPins over visibleToPublic: hidden pin falls away',
  rowKeys(orderByPins(visibleToPublic(ownerFeed), (r) => r.key, ['b', 'e'])) === 'e',
)
check(
  'pinsFirst over visibleToPublic: hidden pin inert, rest keeps order',
  rowKeys(pinsFirst(visibleToPublic(ownerFeed), (r) => r.key, ['b', 'e'])) === 'e,a,c',
)

// ── 6. normalizeHiddenFlag — the API owns `hidden` ──────────────────────────
// Producer contract for the flag section 5 consumes. The regression this
// pins: upstream inprocess rows arrived with `hidden: true` on mints Kismet
// never hid; forwarded bare, visibleToPublic dropped them from PUBLIC
// profiles (visitors included) and the owner dashboard showed a false
// "hidden" badge with nothing to unhide.
{
  // Kismet-hidden: flag set regardless of what upstream sent.
  const kismetHidden = normalizeHiddenFlag({ key: 'k', hidden: undefined }, true)
  check('normalize: Kismet-hidden -> hidden:true', kismetHidden.hidden === true)
  // Upstream stray flag on a Kismet-visible row: stripped, other fields kept.
  const upstream = { key: 'u', name: 'toxic-heritage', hidden: true as unknown }
  const cleaned = normalizeHiddenFlag(upstream, false)
  check('normalize: upstream flag stripped', !('hidden' in cleaned))
  check('normalize: other fields survive the strip', (cleaned as { name?: string }).name === 'toxic-heritage')
  check('normalize: does not mutate the input row', upstream.hidden === true)
  // Clean row: identity (no copy on the common path).
  const clean = { key: 'c' } as { key: string; hidden?: unknown }
  check('normalize: clean row -> same reference', normalizeHiddenFlag(clean, false) === clean)
  // The incident end-to-end: an upstream-flagged VISIBLE mint must reach the
  // public view once normalized; a Kismet-hidden one must not.
  const served = [
    normalizeHiddenFlag({ key: 'failed-mint', hidden: undefined }, true),
    normalizeHiddenFlag({ key: 'toxic-heritage', hidden: true as unknown }, false),
  ] as { key: string; hidden?: boolean }[]
  check(
    'normalize -> visibleToPublic: visible mint survives, hidden mint drops',
    visibleToPublic(served).map((r) => r.key).join(',') === 'toxic-heritage',
  )
}

// ── 7. the per-category cap ─────────────────────────────────────────────────
// The product decision (6 — two full showcase rows on lg+, one full row of
// the six-column dense grid) plus a cap-width ordering pass so the widest
// legal pin set exercises both orderers.
check('MAX_PINS_PER_CATEGORY is 6', MAX_PINS_PER_CATEGORY === 6)
const sixPins = ['j', 'e', 'b', 'g', 'a', 'd']
check('orderByPins at cap width', keys(orderByPins(feed, keyOf, sixPins)) === 'j,e,b,g,a,d')
const fullSix = pinsFirst(feed, keyOf, sixPins)
check('pinsFirst at cap width: pins are the first 6, pin order', keys(fullSix.slice(0, 6)) === 'j,e,b,g,a,d')
check('pinsFirst at cap width: remainder keeps feed order', keys(fullSix.slice(6)) === 'c,f,h,i')

// ── 8. unreachable pins (the owner's only unpin surface for a stale ref) ────
// The strip must list EXACTLY the refs no card is rendering: miss one and the
// owner is stuck at the cap with nothing to unpin; include a rendered one and
// the same artwork offers two competing unpin controls.
check('unreachable: refs with no rendered card', unreachablePins(['a', 'b', 'c'], ['b']).join(',') === 'a,c')
check('unreachable: everything rendered -> none', unreachablePins(['a', 'b'], ['a', 'b', 'z']).length === 0)
check('unreachable: nothing pinned -> none', unreachablePins([], ['a']).length === 0)
check('unreachable: nothing rendered -> all of them', unreachablePins(['a', 'b'], []).join(',') === 'a,b')
check('unreachable: pin order is preserved (newest-pinned first)', unreachablePins(['c', 'a', 'b'], []).join(',') === 'c,a,b')

// parsePinRef is the inverse of lib/showcase's member() — the strip turns a
// stored ref back into the (collection, tokenId) the DELETE body needs, so a
// wrong split would unpin the wrong artwork or 400.
const COLL = '0x1234567890abcdef1234567890abcdef12345678'
const ok = parsePinRef(`${COLL}:7`)
check('parsePinRef: splits at the first colon', ok?.collection === COLL && ok?.tokenId === '7')
check('parsePinRef: round-trips lib/showcase member()', `${ok?.collection}:${ok?.tokenId}` === `${COLL}:7`)
check('parsePinRef: a large uint256 tokenId survives', parsePinRef(`${COLL}:115792089237316195423570985008687907853269984665640564039457584007913129639935`)?.tokenId
  === '115792089237316195423570985008687907853269984665640564039457584007913129639935')
check('parsePinRef: rejects a missing tokenId', parsePinRef(`${COLL}:`) === null)
check('parsePinRef: rejects a missing collection', parsePinRef(':7') === null)
check('parsePinRef: rejects a non-address collection', parsePinRef('notanaddress:7') === null)
check('parsePinRef: rejects a non-numeric tokenId', parsePinRef(`${COLL}:abc`) === null)
check('parsePinRef: rejects a colonless ref', parsePinRef(COLL) === null)

if (failures > 0) {
  console.error(`\nverify-showcase-order: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nverify-showcase-order: all checks passed')
