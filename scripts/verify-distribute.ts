// Verifies the pure distribute-all selection logic (lib/distributePlan.ts): the
// cap, the artist-share-USD ordering, the balance>0 filter, the stable tiebreak,
// and the second-click advancement (once the top CAP are drained, the next CAP
// surface). Run: node --experimental-strip-types scripts/verify-distribute.ts

import {
  planDistributeAll,
  jobArtistUsd,
  jobCurrencies,
  dedupeBySplitAddress,
  decodePayoutTargets,
  DISTRIBUTE_ALL_CAP,
  type SplitJob,
} from '../lib/distributePlan.ts'
import { upstreamReason } from '../lib/upstreamReason.ts'

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

// ── decodePayoutTargets ──────────────────────────────────────────────────────
// Shapes mirror a viem/wagmi multicall result set for payoutTargetCalls:
// [getCreatorRewardRecipient, FPSS.sale, ERC20Minter.sale].
const REWARD = '0xAAaaAAaaAAaAAaAAaAAAaaAAaaaaAaaAAaAAAAA1'
const SALE_SPLIT = '0xBbbBbBBbBBbbBBbBbbbbBbbBBbbBBBbBBbbbBbB2'
const ZERO = '0x0000000000000000000000000000000000000000'
const ok = (result: unknown) => ({ status: 'success' as const, result })
const bad = () => ({ status: 'failure' as const })
const saleRow = (fundsRecipient: string) => ok({
  saleStart: 0n, saleEnd: 0n, maxTokensPerAddress: 0n, pricePerToken: 0n, fundsRecipient,
})

check('targets: both pointers agreeing collapse to ONE (the Kismet mint case)',
  JSON.stringify(decodePayoutTargets([ok(REWARD), saleRow(REWARD), saleRow(ZERO)])) ===
    JSON.stringify([REWARD.toLowerCase()]))

check('targets: a diverged sale fundsRecipient is ALSO returned, reward first',
  JSON.stringify(decodePayoutTargets([ok(REWARD), saleRow(SALE_SPLIT), saleRow(ZERO)])) ===
    JSON.stringify([REWARD.toLowerCase(), SALE_SPLIT.toLowerCase()]))

check('targets: the USDC strategy row is read too',
  JSON.stringify(decodePayoutTargets([ok(REWARD), saleRow(ZERO), saleRow(SALE_SPLIT)])) ===
    JSON.stringify([REWARD.toLowerCase(), SALE_SPLIT.toLowerCase()]))

check('targets: zero addresses (unset sale row) drop out',
  JSON.stringify(decodePayoutTargets([ok(REWARD), saleRow(ZERO), saleRow(ZERO)])) ===
    JSON.stringify([REWARD.toLowerCase()]))

check('targets: a failed reward read still yields the sale fundsRecipient',
  JSON.stringify(decodePayoutTargets([bad(), saleRow(SALE_SPLIT), bad()])) ===
    JSON.stringify([SALE_SPLIT.toLowerCase()]))

check('targets: positionally-decoded tuples (index 4) are accepted',
  JSON.stringify(decodePayoutTargets([ok(REWARD), ok([0n, 0n, 0n, 0n, SALE_SPLIT]), bad()])) ===
    JSON.stringify([REWARD.toLowerCase(), SALE_SPLIT.toLowerCase()]))

check('targets: garbage results resolve to nothing rather than throwing',
  decodePayoutTargets([ok('not-an-address'), ok(null), ok(42)]).length === 0)

check('targets: no reads at all → empty', decodePayoutTargets([]).length === 0)

// ── upstreamReason (leak guard) ──────────────────────────────────────────────
// Surfacing WHY a distribute failed must never re-leak the upstream body that
// `1bf7b1b` closed off: no URLs, no hostnames, no paths, no HTML, bounded.
check('reason: pulls the message out of a JSON envelope',
  upstreamReason('{"error":"split not found"}') === 'split not found')
check('reason: nested { error: { message } } envelope',
  upstreamReason('{"error":{"message":"insufficient balance"}}') === 'insufficient balance')
check('reason: falls through to message/detail keys',
  upstreamReason('{"detail":"relay wallet is not an admin"}') === 'relay wallet is not an admin')
check('reason: an HTML error page carries no reason',
  upstreamReason('<!doctype html><html><body>500</body></html>') === '')
check('reason: an empty body carries no reason', upstreamReason('') === '')
check('reason: a stack dump carries no reason',
  upstreamReason('Error: boom\n    at f (x.js:1:1)') === '')
check('reason: URLs are stripped',
  !/https?:/.test(upstreamReason('{"error":"POST https://api.example.com/api/distribute failed"}')),
  upstreamReason('{"error":"POST https://api.example.com/api/distribute failed"}'))
check('reason: bare hostnames are stripped',
  !/example\.com/.test(upstreamReason('{"error":"api.example.com refused the request"}')),
  upstreamReason('{"error":"api.example.com refused the request"}'))
check('reason: filesystem paths are stripped',
  !upstreamReason('{"error":"cannot read /var/task/index.js"}').includes('/var/task'),
  upstreamReason('{"error":"cannot read /var/task/index.js"}'))
check('reason: long bodies are capped', upstreamReason(JSON.stringify({ error: 'x'.repeat(500) })).length <= 140)
check('reason: a short plain-text body is passed through',
  upstreamReason('Internal Server Error') === 'Internal Server Error')

if (failures > 0) {
  console.error(`\n${failures} distribute check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll distribute checks passed.')
