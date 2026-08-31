// CI-locks the two pagination invariants the feed surfaces depend on
// (lib/feedPagination), both of which produced SILENT data loss before they
// were pinned here.
//
// WHAT IT GUARDS (1) — sample depth must not scale with `page` for a feed whose
// post-merge filter thins the merge. app/api/timeline/route.ts re-derives its
// whole merge per request at depth `page * limit` and then slices
// `[(page-1)*limit, page*limit)`. When a filter keeps only a subset, those two
// walk DIFFERENT sets, so a row deep enough to need page N to enter the sample
// is already past page N's window — unreachable at EVERY page, with page 1
// reporting total_pages: 1 so a paginating client never asks for page 2. The
// simulation at the bottom reproduces that end to end and asserts the fix.
//
// WHAT IT GUARDS (2) — dedupeByKey must keep the FIRST occurrence (the slot the
// reader already scrolled past), must be reference-stable when there is nothing
// to drop, and must not reorder survivors. components/PaginatedGrid appends
// pages into one array, so a repeated key otherwise reaches React directly.
//
// Run: node --experimental-strip-types scripts/verify-feed-pagination.ts

import {
  feedSampleDepth,
  isThinnedFeed,
  dedupeByKey,
  THINNED_SAMPLE_DEPTH,
  SORTED_SAMPLE_FLOOR,
  type FeedThinningInput,
} from '../lib/feedPagination.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

// ---- (1) sample depth ------------------------------------------------------
const thinned = (page: number, limit: number) =>
  feedSampleDepth({ page, limit, sorted: false, thinned: true })
const sorted = (page: number, limit: number) =>
  feedSampleDepth({ page, limit, sorted: true, thinned: false })
const plain = (page: number, limit: number) =>
  feedSampleDepth({ page, limit, sorted: false, thinned: false })

// THE invariant. If this ever goes red, the unreachable-at-every-page bug is back.
check(
  'thinned depth is page-INDEPENDENT',
  [1, 2, 5, 25, 100].every((p) => thinned(p, 50) === thinned(1, 50)),
  [1, 2, 5, 25, 100].map((p) => `p${p}=${thinned(p, 50)}`).join(' '),
)
check('thinned depth is the documented constant', thinned(1, 50) === THINNED_SAMPLE_DEPTH)
check(
  'thinned depth also independent of limit',
  [10, 18, 20, 24, 50, 100].every((l) => thinned(3, l) === THINNED_SAMPLE_DEPTH),
)

// A sorted feed is NOT thinned: deeper pages are how it reaches more content,
// so its sample must keep growing (and never dip under the floor).
check('sorted depth grows with page', sorted(5, 100) > sorted(1, 100), `${sorted(1, 100)} → ${sorted(5, 100)}`)
check('sorted depth never below the floor', sorted(1, 10) === SORTED_SAMPLE_FLOOR)
check('sorted depth follows page*limit once past the floor', sorted(5, 100) === 500)

// Unfiltered newest-first keeps the original page*limit rule exactly.
check('plain depth is page*limit', plain(1, 18) === 18 && plain(4, 18) === 72)

// Thinning wins when a request is BOTH — the roster feed is creators= + sort=.
check(
  'thinned beats sorted when both apply',
  feedSampleDepth({ page: 9, limit: 24, sorted: true, thinned: true }) === THINNED_SAMPLE_DEPTH,
)

// No caller's FIRST page may get a shallower sample than the pre-fix rule gave
// it — that would be a silent content regression rather than a fix.
const preFix = (page: number, limit: number, sortedOrThinned: boolean) =>
  sortedOrThinned ? Math.max(page * limit, 200) : page * limit
for (const [name, limit, isThinned, wasFloored] of [
  ['featured tab', 20, true, true],
  ['roster creators=', 18, true, true],
  ['profile mints creator=', 50, true, false],
  ['profile collected collector=', 50, true, false],
  ['airdrop picker airdroppable=', 100, true, false],
] as [string, number, boolean, boolean][]) {
  const after = feedSampleDepth({ page: 1, limit, sorted: false, thinned: isThinned })
  const before = preFix(1, limit, wasFloored)
  check(`page 1 not shallower than before — ${name}`, after >= before, `${before} → ${after}`)
}

// ---- (1b) which filters count as thinning ---------------------------------
// Every flag asserted individually: forgetting one is silent (the feed
// under-reports page 1's total_pages and the grid never asks past it), and the
// browse filters WERE forgotten on the first pass at this fix.
const NO_FILTERS: FeedThinningInput = {
  featured: false, creatorsRoster: false, creator: false, collector: false,
  airdroppable: false, free: false, media: false, resale: false, soldOut: false,
}
check('no filter → not thinned (the plain home feed keeps its growing sample)', !isThinnedFeed(NO_FILTERS))
for (const k of Object.keys(NO_FILTERS) as (keyof FeedThinningInput)[]) {
  check(`${k}= alone marks the feed thinned`, isThinnedFeed({ ...NO_FILTERS, [k]: true }))
}
check('all flags at once is still thinned', isThinnedFeed({
  featured: true, creatorsRoster: true, creator: true, collector: true,
  airdroppable: true, free: true, media: true, resale: true, soldOut: true,
}))

// ---- (2) dedupeByKey -------------------------------------------------------
type Row = { k: string; page: number }
const key = (r: Row) => r.k

const clean: Row[] = [
  { k: 'a', page: 1 },
  { k: 'b', page: 1 },
  { k: 'c', page: 2 },
]
check('no duplicates → SAME array reference (no allocation)', dedupeByKey(clean, key) === clean)

const dupes: Row[] = [
  { k: 'a', page: 1 },
  { k: 'b', page: 1 },
  { k: 'b', page: 2 }, // the boundary shift: page 2 re-served a page 1 row
  { k: 'c', page: 2 },
]
const out = dedupeByKey(dupes, key)
check('duplicate dropped', out.length === 3)
check('FIRST occurrence kept (the slot already scrolled past)', out[1].page === 1)
check('survivor order preserved', out.map(key).join(',') === 'a,b,c')
check('empty input is a no-op', dedupeByKey([] as Row[], key).length === 0)
check(
  'every key distinct after dedupe',
  new Set(out.map(key)).size === out.length,
)

// ---- (3) end-to-end: the unreachable-at-every-page bug ---------------------
// A faithful reduction of the route: sample each collection's newest N
// (upstream is newest-first), keep only the rows a post-merge filter matches,
// then slice the page. Only `baseSample` differs between the two runs.
function reachableAcrossPages(pageIndependent: boolean): Set<number> {
  const CATALOGUE = 400
  const LIMIT = 18
  const WANTED = [101, 341, 396] // the artist's rows, by depth (1 = newest)
  const seen = new Set<number>()
  for (let page = 1; page <= 25; page++) {
    const baseSample = pageIndependent
      ? feedSampleDepth({ page, limit: LIMIT, sorted: false, thinned: true })
      : page * LIMIT
    const sampleDepth = Math.min(baseSample, CATALOGUE)
    const filtered = WANTED.filter((d) => d <= sampleDepth) // still newest-first
    for (const d of filtered.slice((page - 1) * LIMIT, (page - 1) * LIMIT + LIMIT)) seen.add(d)
  }
  return seen
}
const before = reachableAcrossPages(false)
const after = reachableAcrossPages(true)
check(
  'REGRESSION GUARD: page-coupled depth loses deep rows at every page',
  before.size === 0,
  `reachable=${[...before].join(',') || 'none'}`,
)
check(
  'page-independent depth makes rows inside the sample reachable',
  after.has(101),
  `reachable=${[...after].join(',') || 'none'}`,
)

if (failures > 0) {
  console.error(`\n${failures} feed-pagination check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll feed-pagination checks passed.')
