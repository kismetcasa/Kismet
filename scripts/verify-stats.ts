// Verifies the stats rebuild's pure, load-bearing attribution invariants in CI
// so a regression goes red on the PR instead of silently corrupting artists'
// earnings cards:
//   1. Currency classification FAILS CLOSED — an unknown ERC20 is skipped, not
//      summed into the ETH bucket (where it would later be priced as ETH).
//   2. Attribution precedence — the KV per-moment creator override beats the
//      collection-level creator (delegated/curated mints credit the ARTIST),
//      and a missing creator recovers from the dominant fee recipient.
//   3. Dedup keys — only REAL feed identifiers dedup; no synthetic keys.
//   4. The smart-wallet→EOA remap MERGES scores (never overwrites).
//
// Run: node --experimental-strip-types scripts/verify-stats.ts

import {
  accumulateTransfer,
  classifyTransferCurrency,
  newAccumulateCounters,
  remapEntries,
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

// ── 1. Currency classification fails closed ──────────────────────────────────
check('currency: null -> eth', classifyTransferCurrency(null, USDC) === 'eth')
check('currency: undefined -> eth', classifyTransferCurrency(undefined, USDC) === 'eth')
check('currency: usdc (case-insensitive) -> usdc',
  classifyTransferCurrency(USDC.toUpperCase().replace('0X', '0x'), USDC) === 'usdc')
check('currency: unknown ERC20 -> unknown (NOT eth)',
  classifyTransferCurrency('0x4ed4e862860bed51a9570b96d89af5e1b0efefed', USDC) === 'unknown')

const degen = run({
  value: 5,
  currency: '0x4ed4e862860bed51a9570b96d89af5e1b0efefed',
  moment: { collection: { artist: { address: ARTIST } } },
})
check('accumulate: unknown currency skipped entirely',
  degen.maps[0].size === 0 && degen.maps[1].size === 0 && degen.maps[2].size === 0 &&
    degen.counters.unknownCurrency === 1 && degen.counters.counted === 0,
  JSON.stringify({ eth: [...degen.maps[1]], counters: degen.counters }))

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

const bareString = run({ value: 1, moment: { creator: ARTIST, collection: { artist: { address: OWNER } } } })
check('accumulate: per-moment creator (bare string) beats collection level',
  bareString.maps[0].get(ARTIST.toLowerCase()) === 1, JSON.stringify([...bareString.maps[0]]))

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

if (failures > 0) {
  console.error(`\n${failures} stats check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll stats checks passed.')
