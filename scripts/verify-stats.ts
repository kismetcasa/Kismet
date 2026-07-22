// Verifies the stats rebuild's pure, load-bearing attribution invariants in CI
// so a regression goes red on the PR instead of silently corrupting artists'
// earnings cards:
//   1. Currency classification FAILS CLOSED for VALUE — an unknown ERC20 is
//      never summed into the ETH bucket (where it would later be priced as
//      ETH) — while the currency-independent MINT count is still credited.
//   2. Attribution precedence — the KV per-moment creator override beats the
//      collection-level creator (delegated/curated mints credit the ARTIST),
//      and a missing creator recovers from the dominant fee recipient.
//   3. Dedup keys — only REAL feed identifiers dedup; no synthetic keys.
//   4. The smart-wallet→EOA remap MERGES scores (never overwrites).
//   5. The platform roll-up shares the per-artist gates exactly: gated rows
//      touch nothing; unknown-currency rows count the SALE but never the
//      value; gross value ignores split under-allocation; buyers dedup and
//      only real wallet addresses ever enter the collector set.
//
// Run: node --experimental-strip-types scripts/verify-stats.ts

import {
  accumulateTransfer,
  classifyTransferCurrency,
  dominantRecipientExcluding,
  exceedsGrowthLimit,
  filterPassRoyaltyCredits,
  newAccumulateCounters,
  newPlatformTotals,
  remapEntries,
  resolveMomentCreator,
  storedSplitsToFeeRecipients,
  transferBuyer,
  transferDedupKey,
  transferMomentRef,
  type StatsFeeRecipient,
  type StatsTransfer,
} from '../lib/statsMath.ts'
import {
  shiftDateUtc,
  windowTrendSeries,
  type DailyStatPoint,
} from '../lib/trendMath.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OWNER = '0x000000000000000000000000000000000000aaaa'
const ARTIST = '0x000000000000000000000000000000000000bbbb'
const COLLAB = '0x000000000000000000000000000000000000cccc'
const SW = '0x000000000000000000000000000000000000dddd'
// Stand-in platform payout wallet for the pass-artist-credit tests, and the
// exclude set passed to accumulateTransfer for 'pass' rows.
const PLAT = '0x0000000000000000000000000000000000009999'
const PLATFORM_SET: ReadonlySet<string> = new Set([PLAT.toLowerCase()])

type Maps = [Map<string, number>, Map<string, number>, Map<string, number>]
const run = (
  t: StatsTransfer,
  kvCreator: string | null = null,
): { maps: Maps; counters: ReturnType<typeof newAccumulateCounters> } => {
  const maps: Maps = [new Map(), new Map(), new Map()]
  const counters = newAccumulateCounters()
  accumulateTransfer(t, { usdcAddress: USDC, kvCreator }, ...maps, counters)
  return { maps, counters }
}

// ── 1. Currency classification fails closed for VALUE, never for mints ───────
check('currency: null -> eth', classifyTransferCurrency(null, USDC) === 'eth')
check('currency: undefined -> eth', classifyTransferCurrency(undefined, USDC) === 'eth')
check('currency: zero address -> eth (native sentinel)',
  classifyTransferCurrency('0x0000000000000000000000000000000000000000', USDC) === 'eth')
check('currency: usdc (case-insensitive) -> usdc',
  classifyTransferCurrency(USDC.toUpperCase().replace('0X', '0x'), USDC) === 'usdc')
check('currency: unknown ERC20 -> unknown (NOT eth)',
  classifyTransferCurrency('0x4ed4e862860bed51a9570b96d89af5e1b0efefed', USDC) === 'unknown')

const degen = run({
  value: 5,
  currency: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  moment: { collection: { artist: { address: ARTIST } } },
})
check('accumulate: unknown currency skips VALUE buckets only',
  degen.maps[1].size === 0 && degen.maps[2].size === 0 &&
    degen.counters.unknownCurrency === 1,
  JSON.stringify({ eth: [...degen.maps[1]], usdc: [...degen.maps[2]], counters: degen.counters }))
check('accumulate: unknown currency STILL credits the mint (currency-independent)',
  degen.maps[0].get(ARTIST.toLowerCase()) === 1 && degen.counters.counted === 1,
  JSON.stringify({ mints: [...degen.maps[0]], counters: degen.counters }))

// ── 2. Attribution precedence ────────────────────────────────────────────────
const base: StatsTransfer = {
  value: 0.1,
  currency: null,
  quantity: 2,
  moment: { collection: { artist: { address: OWNER } } },
}

const plain = run(base)
check('accumulate: collection creator fallback credits mints qty + full value',
  plain.maps[0].get(OWNER.toLowerCase()) === 2 &&
    plain.maps[1].get(OWNER.toLowerCase()) === 0.1,
  JSON.stringify([...plain.maps[0], ...plain.maps[1]]))
check('accumulate: collection-tier attribution is counted (residual-misattribution telemetry)',
  plain.counters.collectionFallbacks === 1, JSON.stringify(plain.counters))

const kv = run(base, ARTIST)
check('accumulate: KV creator override beats collection owner (mints)',
  kv.maps[0].get(ARTIST.toLowerCase()) === 2 && !kv.maps[0].has(OWNER.toLowerCase()),
  JSON.stringify([...kv.maps[0]]))
check('accumulate: KV creator override beats collection owner (fallback earnings)',
  kv.maps[1].get(ARTIST.toLowerCase()) === 0.1 && !kv.maps[1].has(OWNER.toLowerCase()),
  JSON.stringify([...kv.maps[1]]))
check('accumulate: KV override counted', kv.counters.kvCreatorOverrides === 1)

const split = run({
  ...base,
  moment: {
    ...base.moment,
    fee_recipients: [
      { artist_address: ARTIST, percent_allocation: 60 },
      { artist_address: COLLAB, percent_allocation: 40 },
    ],
  },
})
check('accumulate: fee_recipients split earnings by percent',
  Math.abs((split.maps[1].get(ARTIST.toLowerCase()) ?? 0) - 0.06) < 1e-12 &&
    Math.abs((split.maps[1].get(COLLAB.toLowerCase()) ?? 0) - 0.04) < 1e-12,
  JSON.stringify([...split.maps[1]]))
check('accumulate: split does NOT divert the mint credit',
  split.maps[0].get(OWNER.toLowerCase()) === 2, JSON.stringify([...split.maps[0]]))

const recovered = run({
  value: 1,
  currency: USDC,
  moment: {
    fee_recipients: [
      { artist_address: COLLAB, percent_allocation: 30 },
      { artist_address: ARTIST, percent_allocation: 70 },
    ],
  },
})
check('accumulate: missing creator recovered from DOMINANT fee recipient',
  recovered.maps[0].get(ARTIST.toLowerCase()) === 1 &&
    recovered.counters.recoveredCreators === 1 && recovered.counters.droppedMints === 0,
  JSON.stringify({ mints: [...recovered.maps[0]], counters: recovered.counters }))
check('accumulate: usdc sale lands in the usdc bucket only',
  recovered.maps[2].size === 2 && recovered.maps[1].size === 0)

const dropped = run({ value: 1, currency: null, moment: {} })
check('accumulate: creator unresolvable -> droppedMints counted, nothing credited',
  dropped.maps[0].size === 0 && dropped.counters.droppedMints === 1 &&
    dropped.counters.counted === 1,
  JSON.stringify(dropped.counters))

const free = run({ value: 0, moment: { collection: { creator: ARTIST } } })
check('accumulate: zero-value row skipped as free',
  free.counters.skippedFree === 1 && free.counters.counted === 0 && free.maps[0].size === 0)

// ── 2c. Corruption backstops: garbage value/qty can't poison a total ─────────
for (const [label, bad] of [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['1e30 (absurd)', 1e30],
] as const) {
  const r = run({ value: bad, moment: { collection: { artist: { address: ARTIST } } } })
  check(`accumulate: corrupt value (${label}) skipped as invalid, nothing credited`,
    r.counters.skippedInvalid === 1 && r.counters.counted === 0 &&
      r.maps[0].size === 0 && r.maps[1].size === 0,
    JSON.stringify(r.counters))
}
const absurdQty = run({
  value: 0.1,
  quantity: 1e12,
  moment: { collection: { artist: { address: ARTIST } } },
})
check('accumulate: absurd quantity falls back to 1 (no mint-count inflation)',
  absurdQty.maps[0].get(ARTIST.toLowerCase()) === 1, JSON.stringify([...absurdQty.maps[0]]))
const nanQty = run({
  value: 0.1,
  quantity: NaN,
  moment: { collection: { artist: { address: ARTIST } } },
})
check('accumulate: NaN quantity falls back to 1',
  nanQty.maps[0].get(ARTIST.toLowerCase()) === 1)

// ── 2d. fee_recipients that over-sum can't over-credit earnings ──────────────
const over = run({
  value: 1,
  currency: null,
  moment: {
    fee_recipients: [
      { artist_address: ARTIST, percent_allocation: 100 },
      { artist_address: COLLAB, percent_allocation: 100 },
    ],
  },
})
const overTotal = (over.maps[1].get(ARTIST.toLowerCase()) ?? 0) + (over.maps[1].get(COLLAB.toLowerCase()) ?? 0)
check('accumulate: Σpct>100 scales down so credited earnings never exceed value',
  Math.abs(overTotal - 1) < 1e-12 &&
    Math.abs((over.maps[1].get(ARTIST.toLowerCase()) ?? 0) - 0.5) < 1e-12,
  JSON.stringify([...over.maps[1]]))
const under = run({
  value: 1,
  currency: null,
  moment: { fee_recipients: [{ artist_address: ARTIST, percent_allocation: 80 }] },
})
check('accumulate: Σpct<100 (unlisted platform cut) credits EXACTLY the listed %',
  Math.abs((under.maps[1].get(ARTIST.toLowerCase()) ?? 0) - 0.8) < 1e-12,
  JSON.stringify([...under.maps[1]]))

// ── 2e. Corrupt percent_allocation can't poison (and then DELETE) a total ────
// A non-finite / overflowing percentage would make divisor→Infinity, credit→
// NaN; the write-time `v > 0` filter then reads NaN as false and drops the
// artist, deleting their real score on the absolute swap. Reject it at the
// filter, and fall back to the resolved creator when NO valid recipient remains.
for (const [label, badPct] of [
  ['Infinity', Infinity],
  ['NaN', NaN],
  ['1e400 (overflows to Infinity)', 1e400],
  ['beyond MAX_SANE_PCT', 2_000_000],
] as const) {
  const r = run({
    value: 2,
    currency: null,
    moment: {
      creator: ARTIST,
      fee_recipients: [{ artist_address: COLLAB, percent_allocation: badPct }],
    },
  })
  const collabScore = r.maps[1].get(COLLAB.toLowerCase()) ?? 0
  const artistScore = r.maps[1].get(ARTIST.toLowerCase()) ?? 0
  check(`accumulate: corrupt percent (${label}) is rejected — no NaN/Infinity credit`,
    Number.isFinite(collabScore) && Number.isFinite(artistScore) &&
      !Number.isNaN(collabScore) && collabScore === 0 &&
      // With no valid recipient, the whole value credits the resolved creator.
      Math.abs(artistScore - 2) < 1e-12,
    JSON.stringify({ eth: [...r.maps[1]] }))
}
// A valid recipient alongside a corrupt one: the corrupt row is dropped, the
// valid one still credits (no poisoning of the surviving recipient).
const mixedPct = run({
  value: 1,
  currency: null,
  moment: {
    fee_recipients: [
      { artist_address: ARTIST, percent_allocation: 50 },
      { artist_address: COLLAB, percent_allocation: Infinity },
    ],
  },
})
check('accumulate: corrupt recipient dropped, valid recipient credits cleanly',
  Math.abs((mixedPct.maps[1].get(ARTIST.toLowerCase()) ?? 0) - 0.5) < 1e-12 &&
    (mixedPct.maps[1].get(COLLAB.toLowerCase()) ?? 0) === 0,
  JSON.stringify([...mixedPct.maps[1]]))

const bareString = run({ value: 1, moment: { creator: ARTIST, collection: { artist: { address: OWNER } } } })
check('accumulate: per-moment creator (bare string) beats collection level',
  bareString.maps[0].get(ARTIST.toLowerCase()) === 1, JSON.stringify([...bareString.maps[0]]))

// ── 2b. resolveMomentCreator: THE shared precedence (stats + timeline + detail)
const rmc = resolveMomentCreator
check('creator: kv wins when it differs from feed',
  JSON.stringify(rmc({ kvCreator: ARTIST, feedCreator: OWNER })) ===
    JSON.stringify({ address: ARTIST, source: 'kv' }))
check('creator: kv equal to feed (case-insensitive) reports feed — no-op for rewrite-on-kv callers',
  JSON.stringify(rmc({ kvCreator: ARTIST.toUpperCase().replace('0X', '0x'), feedCreator: ARTIST })) ===
    JSON.stringify({ address: ARTIST, source: 'feed' }))
check('creator: kv alone wins', rmc({ kvCreator: ARTIST }).source === 'kv')
check('creator: feed > collection',
  rmc({ feedCreator: ARTIST, collectionCreator: OWNER }).address === ARTIST)
check('creator: collection > recipient',
  rmc({ collectionCreator: OWNER, dominantFeeRecipient: COLLAB }).address === OWNER)
check('creator: recipient as last resort',
  JSON.stringify(rmc({ dominantFeeRecipient: COLLAB })) ===
    JSON.stringify({ address: COLLAB, source: 'recipient' }))
check('creator: nothing -> null',
  JSON.stringify(rmc({})) === JSON.stringify({ address: null, source: null }))

const kvEqual = run(
  { value: 1, moment: { creator: ARTIST, collection: { artist: { address: OWNER } } } },
  ARTIST,
)
check('accumulate: kv equal to feed does NOT count as an override',
  kvEqual.counters.kvCreatorOverrides === 0 &&
    kvEqual.maps[0].get(ARTIST.toLowerCase()) === 1,
  JSON.stringify(kvEqual.counters))
check('accumulate: kv-attributed row is NOT a collection fallback',
  kv.counters.collectionFallbacks === 0, JSON.stringify(kv.counters))

// ── 3. Dedup keys: real identifiers only ─────────────────────────────────────
check('dedup: id used', transferDedupKey({ id: 42 }) === 'id:42')
check('dedup: transfer_id used', transferDedupKey({ transfer_id: 'abc' }) === 'tid:abc')
check('dedup: tx hash requires log_index',
  transferDedupKey({ transaction_hash: '0xAB' }) === null &&
    transferDedupKey({ transaction_hash: '0xAB', log_index: 3 }) === 'tx:0xab:3')
check('dedup: no identifier -> null (never synthesized)',
  transferDedupKey({ value: 1, quantity: 1 }) === null)

// ── momentRef extraction ─────────────────────────────────────────────────────
check('momentRef: address + token_id',
  JSON.stringify(transferMomentRef({ moment: { address: '0xC0FFEE', token_id: 7 } })) ===
    JSON.stringify({ collection: '0xc0ffee', tokenId: '7' }))
check('momentRef: collection.address fallback',
  transferMomentRef({ moment: { collection: { address: '0xC0FFEE' }, token_id: '9' } })
    ?.collection === '0xc0ffee')
check('momentRef: missing tokenId -> null',
  transferMomentRef({ moment: { address: '0xC0FFEE' } }) === null)

// ── 4. Smart-wallet remap merges scores ──────────────────────────────────────
const remapped = remapEntries(
  new Map([
    [SW.toLowerCase(), 3],
    [ARTIST.toLowerCase(), 2],
    [COLLAB.toLowerCase(), 5],
  ]),
  new Map([[SW.toLowerCase(), ARTIST.toLowerCase()]]),
)
check('remap: alias score MERGED onto owner (3 + 2 = 5)',
  remapped.get(ARTIST.toLowerCase()) === 5 && !remapped.has(SW.toLowerCase()),
  JSON.stringify([...remapped]))
check('remap: unmapped members pass through', remapped.get(COLLAB.toLowerCase()) === 5)
check('remap: empty remap is identity',
  remapEntries(new Map([['a', 1]]), new Map()).get('a') === 1)

// ── 5. Platform roll-up: same gates, gross value, buyer dedup ────────────────
const BUYER_A = '0x000000000000000000000000000000000000eeee'
const BUYER_B = '0x000000000000000000000000000000000000ffff'

check('buyer: object shape', transferBuyer({ buyer: { address: BUYER_A } }) === BUYER_A)
check('buyer: bare string', transferBuyer({ buyer: BUYER_A }) === BUYER_A)
check('buyer: buyer_address fallback', transferBuyer({ buyer_address: BUYER_A }) === BUYER_A)
check('buyer: to as last resort', transferBuyer({ to: BUYER_A }) === BUYER_A)
check('buyer: preference order (buyer beats to)',
  transferBuyer({ buyer: { address: BUYER_A }, to: BUYER_B }) === BUYER_A)
check('buyer: lowercased', transferBuyer({ buyer: BUYER_A.toUpperCase().replace('0X', '0x') }) === BUYER_A)
check('buyer: zero address rejected (falls through to next field)',
  transferBuyer({ buyer: '0x0000000000000000000000000000000000000000', to: BUYER_B }) === BUYER_B)
check('buyer: non-address garbage rejected', transferBuyer({ buyer: 'alice.eth' }) === null)
check('buyer: absent -> null', transferBuyer({}) === null)

// ── value-jump breaker predicate (unit-drift guard, lib/stats.ts) ────────────
// factor 1000, floors ETH 0.005 / USDC 5 (the live constants).
const GROW = 1000
check('growth: undefined baseline never trips (pre-field / first run)',
  exceedsGrowthLimit(undefined, 1e12, 5, GROW) === false)
check('growth: baseline at/below floor is skipped (dust baseline)',
  exceedsGrowthLimit(5, 1e9, 5, GROW) === false && exceedsGrowthLimit(4, 1e9, 5, GROW) === false)
check('growth: armed at real USDC volume (40 > floor 5)',
  exceedsGrowthLimit(40, 40_000_000, 5, GROW) === true) // ×1e6 unit drift caught
check('growth: armed at real ETH volume (0.9 > floor 0.005)',
  exceedsGrowthLimit(0.9085, 0.9085 * 1e18, 0.005, GROW) === true)
check('growth: plausible organic hour does NOT trip (×100 < ×1000)',
  exceedsGrowthLimit(40, 4000, 5, GROW) === false)
check('growth: exactly ×1000 does not trip (strict >)',
  exceedsGrowthLimit(40, 40_000, 5, GROW) === false)
check('growth: just over ×1000 trips',
  exceedsGrowthLimit(40, 40_001, 5, GROW) === true)

const runPlatform = (
  rows: StatsTransfer[],
): { platform: ReturnType<typeof newPlatformTotals>; counters: ReturnType<typeof newAccumulateCounters> } => {
  const maps: Maps = [new Map(), new Map(), new Map()]
  const counters = newAccumulateCounters()
  const platform = newPlatformTotals()
  for (const t of rows) accumulateTransfer(t, { usdcAddress: USDC, kvCreator: null }, ...maps, counters, platform)
  return { platform, counters }
}

const pGated = runPlatform([
  { value: 0, moment: { collection: { creator: ARTIST } } }, // free
  { value: NaN, moment: { collection: { creator: ARTIST } } }, // invalid
])
check('platform: gated rows (free/invalid) touch nothing',
  pGated.platform.transactions === 0 && pGated.platform.editions === 0 &&
    pGated.platform.eth === 0 && pGated.platform.buyers.size === 0 &&
    pGated.platform.buyerMissing === 0,
  JSON.stringify({ ...pGated.platform, buyers: [...pGated.platform.buyers] }))

const pUnknown = runPlatform([{
  value: 5,
  currency: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  quantity: 3,
  buyer: { address: BUYER_A },
  moment: { collection: { artist: { address: ARTIST } } },
}])
check('platform: unknown currency counts the sale (tx/editions/buyer), never the value',
  pUnknown.platform.transactions === 1 && pUnknown.platform.editions === 3 &&
    pUnknown.platform.buyers.has(BUYER_A) && pUnknown.platform.eth === 0 &&
    pUnknown.platform.usdc === 0,
  JSON.stringify({ ...pUnknown.platform, buyers: [...pUnknown.platform.buyers] }))

const pGross = runPlatform([{
  value: 1,
  currency: null,
  buyer: { address: BUYER_A },
  moment: { fee_recipients: [{ artist_address: ARTIST, percent_allocation: 80 }] },
}])
check('platform: gross ETH is the FULL sale value even when the split under-allocates',
  Math.abs(pGross.platform.eth - 1) < 1e-12, JSON.stringify(pGross.platform.eth))

const pDropped = runPlatform([{ value: 1, quantity: 2, moment: {} }])
check('platform: creator-unresolvable sale still counts editions + value',
  pDropped.platform.editions === 2 && Math.abs(pDropped.platform.eth - 1) < 1e-12 &&
    pDropped.counters.droppedMints === 2,
  JSON.stringify({ ...pDropped.platform, buyers: [] }))

const pBuyers = runPlatform([
  { value: 0.1, buyer: { address: BUYER_A }, moment: { collection: { creator: ARTIST } } },
  { value: 0.2, buyer: { address: BUYER_A.toUpperCase().replace('0X', '0x') }, moment: { collection: { creator: ARTIST } } },
  { value: 0.3, buyer: { address: BUYER_B }, moment: { collection: { creator: ARTIST } } },
  { value: 0.4, moment: { collection: { creator: ARTIST } } }, // no buyer field
])
check('platform: buyers dedup case-insensitively; rows without one count buyerMissing',
  pBuyers.platform.buyers.size === 2 && pBuyers.platform.buyerMissing === 1 &&
    pBuyers.platform.transactions === 4 && pBuyers.platform.editions === 4 &&
    Math.abs(pBuyers.platform.eth - 1) < 1e-12,
  JSON.stringify({ ...pBuyers.platform, buyers: [...pBuyers.platform.buyers] }))

const pUsdc = runPlatform([{ value: 25, currency: USDC, buyer: BUYER_B, moment: { collection: { creator: ARTIST } } }])
check('platform: usdc sale lands in the usdc bucket only',
  pUsdc.platform.usdc === 25 && pUsdc.platform.eth === 0)

check('platform: omitted accumulator is a no-op (existing callers unchanged)', (() => {
  const maps: Maps = [new Map(), new Map(), new Map()]
  const counters = newAccumulateCounters()
  accumulateTransfer(base, { usdcAddress: USDC, kvCreator: null }, ...maps, counters)
  return counters.counted === 1
})())

// ── 6. Platform scope gate: only Kismet-tracked rows fold into the roll-up ──
const runScoped = (
  rows: Array<{ t: StatsTransfer; scope: 'in' | 'pass' | 'out' | 'unknown' }>,
): {
  maps: Maps
  platform: ReturnType<typeof newPlatformTotals>
  counters: ReturnType<typeof newAccumulateCounters>
} => {
  const maps: Maps = [new Map(), new Map(), new Map()]
  const counters = newAccumulateCounters()
  const platform = newPlatformTotals()
  for (const { t, scope } of rows) {
    accumulateTransfer(
      t,
      { usdcAddress: USDC, kvCreator: null, platformAddresses: PLATFORM_SET },
      ...maps, counters, platform, scope,
    )
  }
  return { maps, platform, counters }
}

const sOut = runScoped([{
  t: { value: 1, quantity: 3, buyer: { address: BUYER_A }, moment: { collection: { artist: { address: ARTIST } } } },
  scope: 'out',
}])
check('scope: out-of-scope sale credits NOTHING to the ARTIST maps (cards are Kismet-only)',
  sOut.maps[0].size === 0 && sOut.maps[1].size === 0 && sOut.maps[2].size === 0 &&
    sOut.counters.droppedMints === 0,
  JSON.stringify([...sOut.maps[0], ...sOut.maps[1], ...sOut.maps[2]]))
check('scope: out-of-scope row STILL increments counted (feed-completeness / shrink guard)',
  sOut.counters.counted === 1, JSON.stringify(sOut.counters))
check('scope: out-of-scope sale folds NOTHING into the platform roll-up, counts outOfScope',
  sOut.platform.transactions === 0 && sOut.platform.editions === 0 &&
    sOut.platform.eth === 0 && sOut.platform.buyers.size === 0 &&
    sOut.platform.artists.size === 0 && sOut.platform.outOfScope === 1 &&
    sOut.platform.scopeUnknown === 0,
  JSON.stringify({ ...sOut.platform, buyers: [], artists: [] }))

const sUnknown = runScoped([{ t: { value: 1, moment: { collection: { creator: ARTIST } } }, scope: 'unknown' }])
check('scope: unresolvable-collection row fails CLOSED (excluded, scopeUnknown counted)',
  sUnknown.platform.transactions === 0 && sUnknown.platform.eth === 0 &&
    sUnknown.platform.scopeUnknown === 1 && sUnknown.platform.outOfScope === 0,
  JSON.stringify({ ...sUnknown.platform, buyers: [], artists: [] }))

const sFreeOut = runScoped([{ t: { value: 0, moment: { collection: { creator: ARTIST } } }, scope: 'out' }])
check('scope: gates classify first — a free out-of-scope row is skippedFree, NOT outOfScope',
  sFreeOut.counters.skippedFree === 1 && sFreeOut.platform.outOfScope === 0,
  JSON.stringify({ counters: sFreeOut.counters, outOfScope: sFreeOut.platform.outOfScope }))

// Pass sale with a real split: OWNER (artist) 70%, PLAT (platform payout) 30%.
const sPass = runScoped([{
  t: { value: 0.04, quantity: 2, buyer: { address: BUYER_A }, moment: { fee_recipients: [
    { artist_address: OWNER, percent_allocation: 70 },
    { artist_address: PLAT, percent_allocation: 30 },
  ] } },
  scope: 'pass',
}])
check('scope: pass sale folds GROSS into the passes block, never the art figures',
  sPass.platform.passes.transactions === 1 && sPass.platform.passes.editions === 2 &&
    Math.abs(sPass.platform.passes.eth - 0.04) < 1e-12 && sPass.platform.passes.usdc === 0 &&
    sPass.platform.transactions === 0 && sPass.platform.editions === 0 &&
    sPass.platform.eth === 0 && sPass.platform.artists.size === 0 &&
    sPass.platform.outOfScope === 0,
  JSON.stringify({ ...sPass.platform, buyers: [], artists: [] }))
check('scope: pass sale captures the buyer into passes.buyers, NOT the art buyer set',
  sPass.platform.passes.buyers.has(BUYER_A) && sPass.platform.passes.buyers.size === 1 &&
    sPass.platform.buyers.size === 0,
  JSON.stringify({ pass: [...sPass.platform.passes.buyers], art: [...sPass.platform.buyers] }))
const sPassNoBuyer = runScoped([{
  t: { value: 0.04, moment: { fee_recipients: [{ artist_address: OWNER, percent_allocation: 100 }] } },
  scope: 'pass',
}])
check('scope: pass sale with no buyer field adds nobody to passes.buyers',
  sPassNoBuyer.platform.passes.buyers.size === 0)
check('scope: pass sale credits the REAL artist — count to dominant non-platform recipient',
  sPass.maps[0].get(OWNER.toLowerCase()) === 2 && sPass.maps[0].size === 1,
  JSON.stringify([...sPass.maps[0]]))
check('scope: pass sale credits the REAL artist their EXACT split share (0.04 × 70%)',
  Math.abs((sPass.maps[1].get(OWNER.toLowerCase()) ?? 0) - 0.028) < 1e-12 &&
    sPass.maps[1].size === 1,
  JSON.stringify([...sPass.maps[1]]))
check('scope: pass sale does NOT credit the platform payout wallet (count or earnings)',
  !sPass.maps[0].has(PLAT.toLowerCase()) && !sPass.maps[1].has(PLAT.toLowerCase()),
  JSON.stringify({ mints: [...sPass.maps[0]], eth: [...sPass.maps[1]] }))
check('scope: pass row STILL increments counted (feed-completeness / shrink guard)',
  sPass.counters.counted === 1, JSON.stringify(sPass.counters))

// dominantRecipientExcluding: highest non-excluded share wins; all-excluded → null.
check('dominant: highest non-platform recipient wins the count',
  dominantRecipientExcluding(
    [{ artist_address: PLAT, percent_allocation: 60 }, { artist_address: OWNER, percent_allocation: 40 }],
    PLATFORM_SET,
  ) === OWNER.toLowerCase())
check('dominant: all recipients excluded -> null (row drops, never credits treasury)',
  dominantRecipientExcluding([{ artist_address: PLAT, percent_allocation: 100 }], PLATFORM_SET) === null)

// A pass with NO resolvable real artist (only platform payees) drops the mint
// credit rather than crediting a platform wallet.
const sPassNoArtist = runScoped([{
  t: { value: 1, moment: { fee_recipients: [{ artist_address: PLAT, percent_allocation: 100 }] } },
  scope: 'pass',
}])
check('scope: pass with no real artist drops the count, credits no card, still counts passes',
  sPassNoArtist.maps[0].size === 0 && sPassNoArtist.maps[1].size === 0 &&
    sPassNoArtist.counters.droppedMints === 1 &&
    sPassNoArtist.platform.passes.transactions === 1,
  JSON.stringify({ mints: [...sPassNoArtist.maps[0]], counters: sPassNoArtist.counters }))

const sPassUsdc = runScoped([{
  t: { value: 50, currency: USDC, moment: { fee_recipients: [{ artist_address: OWNER, percent_allocation: 100 }] } },
  scope: 'pass',
}])
check('scope: pass USDC sale — passes.usdc gross + artist credited in usdc map',
  sPassUsdc.platform.passes.usdc === 50 && sPassUsdc.platform.passes.eth === 0 &&
    sPassUsdc.maps[2].get(OWNER.toLowerCase()) === 50,
  JSON.stringify({ passes: sPassUsdc.platform.passes, usdc: [...sPassUsdc.maps[2]] }))

const sIn = runScoped([
  { t: { value: 0.5, quantity: 2, buyer: { address: BUYER_A }, moment: { collection: { artist: { address: ARTIST } } } }, scope: 'in' },
  { t: { value: 0.25, quantity: 4, moment: {} }, scope: 'in' }, // creator unresolvable
  { t: { value: 5, currency: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed', moment: { collection: { artist: { address: COLLAB } } } }, scope: 'in' },
  { t: { value: 9, buyer: { address: BUYER_B }, moment: { collection: { artist: { address: OWNER } } } }, scope: 'out' },
  { t: { value: 0.02, moment: { fee_recipients: [{ artist_address: OWNER, percent_allocation: 100 }] } }, scope: 'pass' },
])
check('scope: in-scope rows fold artists/dropped/unknownCurrency into the roll-up',
  sIn.platform.artists.has(ARTIST.toLowerCase()) && sIn.platform.artists.has(COLLAB.toLowerCase()) &&
    sIn.platform.artists.size === 2 && sIn.platform.droppedMints === 4 &&
    sIn.platform.unknownCurrency === 1 && sIn.platform.editions === 7 &&
    Math.abs(sIn.platform.eth - 0.75) < 1e-12 && !sIn.platform.buyers.has(BUYER_B),
  JSON.stringify({ ...sIn.platform, buyers: [...sIn.platform.buyers], artists: [...sIn.platform.artists] }))
check('scope: invariant — transactions + passes.transactions + outOfScope + scopeUnknown === counted',
  sIn.platform.transactions + sIn.platform.passes.transactions +
    sIn.platform.outOfScope + sIn.platform.scopeUnknown ===
    sIn.counters.counted && sIn.counters.counted === 5,
  JSON.stringify({ tx: sIn.platform.transactions, pass: sIn.platform.passes.transactions, out: sIn.platform.outOfScope, unk: sIn.platform.scopeUnknown, counted: sIn.counters.counted }))
check('scope: per-artist MAPS reflect in-art + pass-artist; out-scope OWNER sale is absent',
  // mints: ARTIST=2 (in), COLLAB=1 (in, unknown-currency still mints), OWNER=1
  // (pass split → real artist). OWNER's OUT-scope sale (value 9) credits
  // nothing. eth: ARTIST=0.5 (in) + OWNER=0.02 (pass share); COLLAB's row is
  // unknown-currency → value skipped.
  sIn.maps[0].get(ARTIST.toLowerCase()) === 2 &&
    sIn.maps[0].get(COLLAB.toLowerCase()) === 1 &&
    sIn.maps[0].get(OWNER.toLowerCase()) === 1 &&
    sIn.maps[0].size === 3 &&
    Math.abs((sIn.maps[1].get(ARTIST.toLowerCase()) ?? 0) - 0.5) < 1e-12 &&
    Math.abs((sIn.maps[1].get(OWNER.toLowerCase()) ?? 0) - 0.02) < 1e-12 &&
    sIn.maps[1].size === 2 &&
    sIn.counters.droppedMints === 4,
  JSON.stringify({ mints: [...sIn.maps[0]], eth: [...sIn.maps[1]], droppedMints: sIn.counters.droppedMints }))
check('scope: default scope is in — pre-scope callers keep folding (back-compat)',
  (() => {
    const maps: Maps = [new Map(), new Map(), new Map()]
    const counters = newAccumulateCounters()
    const platform = newPlatformTotals()
    accumulateTransfer(
      { value: 1, moment: { collection: { creator: ARTIST } } },
      { usdcAddress: USDC, kvCreator: null }, ...maps, counters, platform,
    )
    return platform.transactions === 1 && platform.eth === 1
  })())

// ── 7. Pass artist-net + authoritative stored-split source + secondary filter ─
// The primary pass path now (a) sources its split from the AUTHORITATIVE
// stored-split override (opts.passSplitRecipients) rather than the feed's
// speculative fee_recipients, (b) aggregates artist-net into passes.artistEth/
// Usdc from the SAME per-recipient share bumped onto the card, and (c) surfaces
// an unattributable pass loudly via counters.passUnattributed.
const runPass = (
  t: StatsTransfer,
  passSplitRecipients: StatsFeeRecipient[] | null,
): { maps: Maps; platform: ReturnType<typeof newPlatformTotals>; counters: ReturnType<typeof newAccumulateCounters> } => {
  const maps: Maps = [new Map(), new Map(), new Map()]
  const counters = newAccumulateCounters()
  const platform = newPlatformTotals()
  accumulateTransfer(
    t,
    { usdcAddress: USDC, kvCreator: null, platformAddresses: PLATFORM_SET, passSplitRecipients },
    ...maps, counters, platform, 'pass',
  )
  return { maps, platform, counters }
}

const PASS_SPLIT_20_80: StatsFeeRecipient[] = [
  { artist_address: OWNER, percent_allocation: 20 },
  { artist_address: PLAT, percent_allocation: 80 },
]

// The live Turro case: 11 pass editions × 0.044 ETH, artist 20% / platform 80%.
{
  const maps: Maps = [new Map(), new Map(), new Map()]
  const counters = newAccumulateCounters()
  const platform = newPlatformTotals()
  for (let n = 0; n < 11; n++) {
    accumulateTransfer(
      { value: 0.044, quantity: 1, id: `pass-${n}`, moment: {} },
      { usdcAddress: USDC, kvCreator: null, platformAddresses: PLATFORM_SET, passSplitRecipients: PASS_SPLIT_20_80 },
      ...maps, counters, platform, 'pass',
    )
  }
  check('pass: 11×0.044 @ 20% → gross 0.484, artist-net 0.0968, card 0.0968 (the live Turro case)',
    Math.abs(platform.passes.eth - 0.484) < 1e-9 &&
      Math.abs(platform.passes.artistEth - 0.0968) < 1e-9 &&
      Math.abs((maps[1].get(OWNER.toLowerCase()) ?? 0) - 0.0968) < 1e-9 &&
      maps[0].get(OWNER.toLowerCase()) === 11 &&
      platform.passes.transactions === 11 && platform.passes.editions === 11 &&
      !maps[1].has(PLAT.toLowerCase()),
    JSON.stringify({ eth: platform.passes.eth, artistEth: platform.passes.artistEth, ownerEth: maps[1].get(OWNER.toLowerCase()), ownerMints: maps[0].get(OWNER.toLowerCase()) }))
  check('pass: artist-net can never exceed gross (invariant artistEth ≤ passes.eth)',
    platform.passes.artistEth <= platform.passes.eth + 1e-12)
}

// The stored-split override REPLACES the feed's fee_recipients on a pass row.
{
  const { maps, platform } = runPass(
    { value: 0.044, moment: { fee_recipients: [{ artist_address: COLLAB, percent_allocation: 100 }] } },
    PASS_SPLIT_20_80,
  )
  check('pass: stored-split override REPLACES feed fee_recipients (real artist credited, feed COLLAB ignored)',
    Math.abs((maps[1].get(OWNER.toLowerCase()) ?? 0) - 0.0088) < 1e-12 &&
      !maps[1].has(COLLAB.toLowerCase()) && !maps[1].has(PLAT.toLowerCase()) &&
      maps[0].get(OWNER.toLowerCase()) === 1 &&
      Math.abs(platform.passes.artistEth - 0.0088) < 1e-12,
    JSON.stringify({ eth: [...maps[1]], mints: [...maps[0]] }))
}

// A garbage percent in the STORED override is rejected by the same corruption
// guard as a garbage feed value (no NaN divisor, surviving recipient credited).
{
  const { maps } = runPass(
    { value: 1, moment: {} },
    [{ artist_address: OWNER, percent_allocation: 20 }, { artist_address: COLLAB, percent_allocation: Infinity }],
  )
  check('pass: corrupt pct in the stored override is rejected by the same guard as feed values',
    Number.isFinite(maps[1].get(OWNER.toLowerCase()) ?? 0) &&
      Math.abs((maps[1].get(OWNER.toLowerCase()) ?? 0) - 0.2) < 1e-12 &&
      (maps[1].get(COLLAB.toLowerCase()) ?? 0) === 0,
    JSON.stringify([...maps[1]]))
}

// A pass split naming NO real artist (all platform payees) credits no card and
// surfaces loudly via passUnattributed — never a silent bare drop.
{
  const { maps, platform, counters } = runPass({ value: 0.044, quantity: 2, moment: {} }, [
    { artist_address: PLAT, percent_allocation: 100 },
  ])
  check('pass: split with NO real artist → no card credit, passUnattributed surfaced, gross still counted',
    maps[0].size === 0 && maps[1].size === 0 &&
      counters.passUnattributed === 2 && counters.droppedMints === 2 &&
      platform.passes.transactions === 1 && Math.abs(platform.passes.eth - 0.044) < 1e-12 &&
      platform.passes.artistEth === 0,
    JSON.stringify({ passUnattributed: counters.passUnattributed, droppedMints: counters.droppedMints, artistEth: platform.passes.artistEth }))
}

// Pinned-risk case: an un-excluded 80% payee IS mis-credited — this is exactly
// the Gap the RESOLVED exclude set (admin/payout, wired in lib/stats.ts) closes.
{
  const STRAY = '0x0000000000000000000000000000000000008888' // NOT in PLATFORM_SET
  const { maps, platform } = runPass({ value: 0.044, moment: {} }, [
    { artist_address: OWNER, percent_allocation: 20 },
    { artist_address: STRAY, percent_allocation: 80 },
  ])
  check('pass: an UN-excluded 80% payee is mis-credited — proves the resolved exclude set is load-bearing (Gap A)',
    maps[0].get(STRAY.toLowerCase()) === 1 &&
      Math.abs(platform.passes.artistEth - 0.044) < 1e-12,
    JSON.stringify({ mints: [...maps[0]], artistEth: platform.passes.artistEth }))
}

// storedSplitsToFeeRecipients: the field-name mapping a silent typo could break.
check('storedSplitsToFeeRecipients: address→artist_address, percentAllocation→percent_allocation',
  JSON.stringify(storedSplitsToFeeRecipients([
    { address: OWNER, percentAllocation: 20 },
    { address: PLAT, percentAllocation: 80 },
  ])) === JSON.stringify([
    { artist_address: OWNER, percent_allocation: 20 },
    { artist_address: PLAT, percent_allocation: 80 },
  ]))

// filterPassRoyaltyCredits: the SECONDARY pass exclusion — pass-scoped ONLY.
{
  const credits = [
    { member: OWNER.toLowerCase(), amount: 0.2 },
    { member: PLAT.toLowerCase(), amount: 0.8 },
  ]
  check('filterPassRoyaltyCredits: PASS drops platform members (treasury royalty not booked as creator royalty)',
    JSON.stringify(filterPassRoyaltyCredits(credits, true, PLATFORM_SET)) ===
      JSON.stringify([{ member: OWNER.toLowerCase(), amount: 0.2 }]))
  check('filterPassRoyaltyCredits: NON-pass passes through unchanged (art royalties keep crediting residencies)',
    filterPassRoyaltyCredits(credits, false, PLATFORM_SET).length === 2 &&
      filterPassRoyaltyCredits(credits, false, PLATFORM_SET) === credits)
}

// ── Trend windowing (lib/trendMath) ──────────────────────────────────────────
// shiftDateUtc must cross month / year / leap boundaries in UTC — a local-time
// shifter would slip a day under DST, and every window cutoff depends on it.
check('shiftDateUtc: −1 across a month boundary', shiftDateUtc('2026-03-01', -1) === '2026-02-28')
check('shiftDateUtc: −1 across a year boundary', shiftDateUtc('2026-01-01', -1) === '2025-12-31')
check('shiftDateUtc: −1 lands on Feb 29 in a leap year', shiftDateUtc('2024-03-01', -1) === '2024-02-29')

{
  // A dense 40-day series whose value strictly climbs, so window edges and the
  // cumulative passthrough are both checkable. i=0 → 2026-01-01, i=39 → 2026-02-09.
  const days = 40
  const series: DailyStatPoint[] = Array.from({ length: days }, (_, i) => {
    const v = i + 1
    return {
      date: shiftDateUtc('2026-01-01', i),
      volumeEth: v,
      volumeUsdc: 0,
      artistEth: v * 10,
      artistUsdc: 0,
      platformEth: v * 100,
      platformUsdc: 0,
      ethUsd: 2000,
    }
  })
  const last = series[series.length - 1].date

  const w7 = windowTrendSeries(series, 'volume', 'eth', '7d')
  check('windowTrendSeries: 7d keeps exactly the last 7 points, inclusive',
    w7.length === 7 && w7[0].date === shiftDateUtc(last, -6) && w7[6].date === last,
    JSON.stringify(w7.map((p) => p.date)))
  check('windowTrendSeries: 30d keeps the last 30; all keeps every point',
    windowTrendSeries(series, 'volume', 'eth', '30d').length === 30 &&
      windowTrendSeries(series, 'volume', 'eth', 'all').length === days)
  check('windowTrendSeries: the window is measured from the series latest, not "now"',
    w7[6].value === 40)

  const artistAll = windowTrendSeries(series, 'artist', 'eth', 'all')
  const platAll = windowTrendSeries(series, 'platform', 'eth', 'all')
  check('windowTrendSeries: metric selects the volume / artist / platform legs',
    artistAll[artistAll.length - 1].value === 400 && platAll[platAll.length - 1].value === 4000)
}

{
  // Honest-historical denomination: USD values each day at ITS OWN price; ETH
  // converts the usdc leg at the day's price and DROPS it when the price is 0.
  const series: DailyStatPoint[] = [
    { date: '2026-01-01', volumeEth: 1, volumeUsdc: 500, artistEth: 0, artistUsdc: 0, platformEth: 0, platformUsdc: 0, ethUsd: 1000 },
    { date: '2026-01-02', volumeEth: 2, volumeUsdc: 500, artistEth: 0, artistUsdc: 0, platformEth: 0, platformUsdc: 0, ethUsd: 3000 },
    { date: '2026-01-03', volumeEth: 1, volumeUsdc: 500, artistEth: 0, artistUsdc: 0, platformEth: 0, platformUsdc: 0, ethUsd: 0 },
  ]
  const usd = windowTrendSeries(series, 'volume', 'usd', 'all')
  check('windowTrendSeries: USD values each day at its OWN recorded price (not today\'s)',
    usd[0].value === 1 * 1000 + 500 && usd[1].value === 2 * 3000 + 500,
    JSON.stringify(usd.map((p) => p.value)))
  check('windowTrendSeries: USD with an unavailable (0) price contributes only the usdc leg',
    usd[2].value === 500)

  const eth = windowTrendSeries(series, 'volume', 'eth', 'all')
  check('windowTrendSeries: ETH converts the usdc leg at the day price',
    eth[0].value === 1 + 500 / 1000 && eth[1].value === 2 + 500 / 3000)
  check('windowTrendSeries: ETH drops the usdc leg when the price is unavailable (never Infinity)',
    eth[2].value === 1 && Number.isFinite(eth[2].value))
}

check('windowTrendSeries: empty series → []', windowTrendSeries([], 'volume', 'eth', 'all').length === 0)

{
  // Defensive sort — unsorted input must come back ascending by date.
  const series: DailyStatPoint[] = [
    { date: '2026-01-03', volumeEth: 3, volumeUsdc: 0, artistEth: 0, artistUsdc: 0, platformEth: 0, platformUsdc: 0, ethUsd: 1 },
    { date: '2026-01-01', volumeEth: 1, volumeUsdc: 0, artistEth: 0, artistUsdc: 0, platformEth: 0, platformUsdc: 0, ethUsd: 1 },
    { date: '2026-01-02', volumeEth: 2, volumeUsdc: 0, artistEth: 0, artistUsdc: 0, platformEth: 0, platformUsdc: 0, ethUsd: 1 },
  ]
  const w = windowTrendSeries(series, 'volume', 'eth', 'all')
  check('windowTrendSeries: unsorted input is returned ascending by date',
    w[0].date === '2026-01-01' && w[1].date === '2026-01-02' && w[2].date === '2026-01-03')
}

if (failures > 0) {
  console.error(`\n${failures} stats check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll stats checks passed.')
