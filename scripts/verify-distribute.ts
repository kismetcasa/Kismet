// Verifies the pure distribute-all selection logic (lib/distributePlan.ts): the
// cap, the artist-share-USD ordering, the balance>0 filter, the stable tiebreak,
// and the second-click advancement (once the top CAP are drained, the next CAP
// surface). Run: node --experimental-strip-types scripts/verify-distribute.ts

import {
  planDistributeAll,
  jobArtistUsd,
  jobCurrencies,
  dedupeBySplitAddress,
  DISTRIBUTE_ALL_CAP,
  type SplitJob,
} from '../lib/distributePlan.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const ETH = 10n ** 18n // 1 ETH in wei
const USDC = 10n ** 6n // 1 USDC in base units
const ETHUSD = 2000

const job = (
  id: string,
  pct: number,
  ethWei: bigint,
  usdcBase: bigint,
): SplitJob => ({
  collection: `0x${'0'.repeat(39)}${id}`,
  tokenId: '1',
  splitAddress: `0x${'a'.repeat(39)}${id}`,
  pct,
  ethWei,
  usdcBase,
})

// ── artist-share valuation ───────────────────────────────────────────────────
check('value: eth share priced + usdc share, scaled by pct',
  Math.abs(jobArtistUsd(job('1', 50, ETH, 100n * USDC), ETHUSD) - (0.5 * 2000 + 50)) < 1e-9,
  String(jobArtistUsd(job('1', 50, ETH, 100n * USDC), ETHUSD)))
check('value: price null → eth leg contributes 0 (usdc share only)',
  jobArtistUsd(job('1', 100, ETH, 5n * USDC), null) === 5)
check('value: zero balances → 0', jobArtistUsd(job('1', 100, 0n, 0n), ETHUSD) === 0)

// ── filter: balance > 0 ──────────────────────────────────────────────────────
check('filter: zero-balance jobs are excluded entirely',
  planDistributeAll([job('1', 100, 0n, 0n), job('2', 100, ETH, 0n)], ETHUSD).length === 1)

// ── ordering: highest artist-$ first ─────────────────────────────────────────
const ordered = planDistributeAll(
  [
    job('1', 100, 1n * ETH, 0n), // $2000
    job('2', 100, 0n, 5000n * USDC), // $5000
    job('3', 100, 0n, 100n * USDC), // $100
  ],
  ETHUSD,
)
check('order: descending artist-$ (usdc 5000 > eth 2000 > usdc 100)',
  ordered.map((j) => j.tokenId === '1' ? 'a' : '') && // noop keep types
    Number(ordered[0].usdcBase) === 5000 * 1e6 &&
    ordered[1].ethWei === 1n * ETH &&
    Number(ordered[2].usdcBase) === 100 * 1e6,
  JSON.stringify(ordered.map((j) => j.splitAddress.slice(-1))))

// ── pct scaling affects order ────────────────────────────────────────────────
const byShare = planDistributeAll(
  [
    job('1', 10, 10n * ETH, 0n), // share = 1 ETH = $2000
    job('2', 90, 3n * ETH, 0n), // share = 2.7 ETH = $5400
  ],
  ETHUSD,
)
check('order: uses the artist SHARE (pct×balance), not the raw balance',
  byShare[0].pct === 90, JSON.stringify(byShare.map((j) => j.pct)))

// ── cap + second-click advancement ───────────────────────────────────────────
const many: SplitJob[] = Array.from({ length: 30 }, (_, i) =>
  // Descending value: token i worth (30 - i) USDC.
  job(String.fromCharCode(97 + (i % 26)) + i, 100, 0n, BigInt(30 - i) * USDC),
)
const first = planDistributeAll(many, ETHUSD, DISTRIBUTE_ALL_CAP)
check('cap: at most CAP jobs selected', first.length === DISTRIBUTE_ALL_CAP)
check('cap: the CAP most-valuable are chosen (top value = 30 USDC)',
  Number(first[0].usdcBase) === 30 * 1e6 &&
    Number(first[first.length - 1].usdcBase) === (30 - (DISTRIBUTE_ALL_CAP - 1)) * 1e6,
  JSON.stringify(first.map((j) => Number(j.usdcBase) / 1e6)))

// Simulate the second click: the selected 20 are now drained to 0; re-plan.
const drained = new Set(first.map((j) => j.splitAddress))
const afterFirst = many.map((j) =>
  drained.has(j.splitAddress) ? { ...j, ethWei: 0n, usdcBase: 0n } : j,
)
const second = planDistributeAll(afterFirst, ETHUSD, DISTRIBUTE_ALL_CAP)
check('second click: the remaining (next CAP by value) surface, none repeated',
  second.length === 30 - DISTRIBUTE_ALL_CAP &&
    second.every((j) => !drained.has(j.splitAddress)) &&
    Number(second[0].usdcBase) === (30 - DISTRIBUTE_ALL_CAP) * 1e6,
  JSON.stringify({ n: second.length, top: Number(second[0]?.usdcBase) / 1e6 }))

// ── stable tiebreak ──────────────────────────────────────────────────────────
const tied = planDistributeAll(
  [job('2', 100, 0n, USDC), job('1', 100, 0n, USDC)],
  ETHUSD,
)
check('tiebreak: equal value → deterministic by splitAddress',
  tied[0].splitAddress < tied[1].splitAddress, JSON.stringify(tied.map((j) => j.splitAddress.slice(-1))))

// ── shared-split dedupe ──────────────────────────────────────────────────────
// The 2026-07-17 production case: five moments (two collections) all paying one
// deterministic 0xSplits contract at pct=95. Per-moment jobs made pending show
// 5× the artist's real share ($12.49 for a $2.50 balance) and distribute-all
// fire 5 duplicate calls. Each pot must survive as exactly ONE entry.
const SHARED = `0x${'5'.repeat(40)}`
const sharedCase = [
  { splitAddress: SHARED, pct: 95, collection: '0xcoll-a', tokenId: '4' },
  { splitAddress: SHARED, pct: 95, collection: '0xcoll-b', tokenId: '1' },
  { splitAddress: SHARED, pct: 95, collection: '0xcoll-b', tokenId: '2' },
  { splitAddress: SHARED, pct: 95, collection: '0xcoll-b', tokenId: '3' },
  { splitAddress: SHARED, pct: 95, collection: '0xcoll-b', tokenId: '4' },
]
const dedupedShared = dedupeBySplitAddress(sharedCase)
check('dedupe: five moments on one split collapse to one entry',
  dedupedShared.length === 1, `got ${dedupedShared.length}`)
check('dedupe: first-seen moment kept as the representative',
  dedupedShared[0]?.collection === '0xcoll-a' && dedupedShared[0]?.tokenId === '4',
  JSON.stringify(dedupedShared[0]))
check('dedupe: agreeing pcts pass through unchanged', dedupedShared[0]?.pct === 95)

const mixed = dedupeBySplitAddress([
  { splitAddress: `0x${'a'.repeat(40)}`, pct: 50 },
  { splitAddress: SHARED, pct: 95 },
  { splitAddress: `0x${'b'.repeat(40)}`, pct: 10 },
  { splitAddress: SHARED, pct: 95 },
])
check('dedupe: distinct splits untouched, first-seen order preserved',
  mixed.length === 3 &&
    mixed[0].splitAddress === `0x${'a'.repeat(40)}` &&
    mixed[1].splitAddress === SHARED &&
    mixed[2].splitAddress === `0x${'b'.repeat(40)}`,
  JSON.stringify(mixed.map((e) => e.splitAddress.slice(0, 4))))

check('dedupe: corrupt pct disagreement keeps the MINIMUM (under-report)',
  dedupeBySplitAddress([
    { splitAddress: SHARED, pct: 95 },
    { splitAddress: SHARED, pct: 40 },
  ])[0].pct === 40)

check('dedupe: address key is case-insensitive',
  dedupeBySplitAddress([
    { splitAddress: SHARED.toUpperCase().replace('0X', '0x'), pct: 95 },
    { splitAddress: SHARED, pct: 95 },
  ]).length === 1)

check('dedupe: empty input → empty output', dedupeBySplitAddress([]).length === 0)

// End-to-end regression: the pot held 0.0014 ETH; the artist's 95% share is
// ~$2.50 at $1880 — five per-moment jobs summed to ~$12.49 before the dedupe.
const POT = 1_400_000_000_000_000n // 0.0014 ETH in wei
const fiveJobs: SplitJob[] = Array.from({ length: 5 }, (_, i) => ({
  ...job(String(i), 95, POT, 0n),
  splitAddress: SHARED,
}))
const sumUsd = (js: SplitJob[]) => js.reduce((s, j) => s + jobArtistUsd(j, 1880), 0)
check('regression: per-moment sum reproduces the inflated ~$12.49',
  Math.abs(sumUsd(fiveJobs) - 12.502) < 0.01, sumUsd(fiveJobs).toFixed(4))
check('regression: deduped sum is the artist\'s real ~$2.50 share',
  Math.abs(sumUsd(dedupeBySplitAddress(fiveJobs)) - 2.5004) < 0.01,
  sumUsd(dedupeBySplitAddress(fiveJobs)).toFixed(4))
check('regression: distribute-all plans ONE call for the shared pot',
  planDistributeAll(dedupeBySplitAddress(fiveJobs), 1880).length === 1)

// ── jobCurrencies ────────────────────────────────────────────────────────────
check('currencies: both when both balances present',
  JSON.stringify(jobCurrencies(job('1', 100, ETH, USDC))) === JSON.stringify(['eth', 'usdc']))
check('currencies: eth only', JSON.stringify(jobCurrencies(job('1', 100, ETH, 0n))) === JSON.stringify(['eth']))
check('currencies: usdc only', JSON.stringify(jobCurrencies(job('1', 100, 0n, USDC))) === JSON.stringify(['usdc']))

if (failures > 0) {
  console.error(`\n${failures} distribute check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll distribute checks passed.')
