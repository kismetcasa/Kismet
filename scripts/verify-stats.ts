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
  newAccumulateCounters,
  newPlatformTotals,
  remapEntries,
  resolveMomentCreator,
  transferBuyer,
  transferDedupKey,
  transferMomentRef,
  type StatsTransfer,
} from '../lib/statsMath.ts'

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

if (failures > 0) {
  console.error(`\n${failures} stats check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll stats checks passed.')
