// CI oracle for the Experience (the capsule machine). Pins the pure core that
// decides WHAT A PLAYER GETS and WHETHER A MACHINE MAY EXIST — the two things
// a refactor could silently break with real money and real artwork on the line.
//
// Everything asserted here runs the production functions directly; nothing is
// re-implemented in the test, so a behavioural change fails here rather than in
// front of a player who has already paid.
//
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types \
//        --import ./scripts/register-ts-alias.mjs scripts/verify-experience.ts

import { createHash } from 'node:crypto'
import {
  MAX_POOL_ARTISTS,
  MAX_WEIGHT,
  deriveOdds,
  drawAtAttempt,
  eligible,
  entryKey,
  isDrawable,
  oddsAreCoherent,
  pickIndex,
  poolArtists,
  selectByHash,
  totalWeight,
  withExcluded,
  withLiveStanding,
} from '../lib/experience/draw.ts'
import { checkLineup, checkSolvency, coverage, findFloorPiece } from '../lib/experience/solvency.ts'
import { runDraw } from '../lib/experience/runDraw.ts'
import {
  canonicalSnapshot,
  commitmentFor,
  drawHash,
  epochFor,
  nextEpoch,
  snapshotHash,
  verifyDraw,
} from '../lib/experience/fairness.ts'
import {
  artworkTitle,
  formatOddsRatio,
  formatProbability,
  formatRemaining,
  parseArtworkRef,
} from '../lib/experience/format.ts'
import type { PoolEntry, SnapshotEntry } from '../lib/experience/types.ts'

let failures = 0
/** Deterministic 64-hex strings, so the randomised checks replay identically in CI. */
const createHashHex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const snap = (over: Partial<SnapshotEntry> = {}): SnapshotEntry => ({
  collection: '0xaaaa000000000000000000000000000000000001',
  tokenId: '1',
  artist: '0xart0000000000000000000000000000000000001',
  weight: 10,
  supply: 5,
  remaining: 5,
  ...over,
})

// ─── 1. Drawability: reject rather than coerce ───────────────────────────────
console.log('\n1. drawability')
check('healthy entry is drawable', isDrawable(snap()))
check('exhausted entry is not', !isDrawable(snap({ remaining: 0 })))
check('unlimited (remaining null) is drawable', isDrawable(snap({ remaining: null })))
// A corrupted weight must EXCLUDE the entry, never be coerced to 1 — silently
// treating bad data as valid would let one bad write reshape a published table.
check('zero weight excluded', !isDrawable(snap({ weight: 0 })))
check('negative weight excluded', !isDrawable(snap({ weight: -5 })))
check('fractional weight excluded', !isDrawable(snap({ weight: 1.5 })))
check('NaN weight excluded', !isDrawable(snap({ weight: NaN })))
check('over-cap weight excluded', !isDrawable(snap({ weight: MAX_WEIGHT + 1 })))
check('at-cap weight allowed', isDrawable(snap({ weight: MAX_WEIGHT })))
check('fractional remaining excluded', !isDrawable(snap({ remaining: 2.5 })))

// ─── 2. Odds are derived, and coherent ──────────────────────────────────────
console.log('\n2. derived odds')
{
  const pool = [snap({ tokenId: '1', weight: 30 }), snap({ tokenId: '2', weight: 10 })]
  const rows = deriveOdds(pool)
  check('probabilities are weight/Σweight', Math.abs(rows[0].probability - 0.75) < 1e-12)
  check('second row matches', Math.abs(rows[1].probability - 0.25) < 1e-12)
  check('rows sum to 1', oddsAreCoherent(rows))
  check('totalWeight sums eligible only', totalWeight(pool) === 40)
  check('eligible() returns only drawable entries', eligible([...pool, snap({ tokenId: '3', remaining: 0 })]).length === 2)
  check('eligible() preserves order (selection walks it)', eligible(pool)[0].tokenId === '1')
}
{
  // An exhausted piece stays VISIBLE at probability 0 rather than vanishing —
  // hiding it would let a machine quietly become a different machine than the
  // one a player was shown.
  const pool = [snap({ tokenId: '1', weight: 10 }), snap({ tokenId: '2', weight: 10, remaining: 0 })]
  const rows = deriveOdds(pool)
  check('exhausted row is retained', rows.length === 2)
  check('exhausted row reads 0', rows[1].probability === 0)
  check('remaining row absorbs all probability', Math.abs(rows[0].probability - 1) < 1e-12)
  check('still coherent with an exhausted row', oddsAreCoherent(rows))
}
{
  const rows = deriveOdds([snap({ remaining: 0 })])
  check('all-exhausted pool yields all-zero odds', rows.every((r) => r.probability === 0))
  check('all-zero table counts as coherent', oddsAreCoherent(rows))
}

// ─── 3. Selection: deterministic, weighted, total ───────────────────────────
console.log('\n3. selection')
{
  const pool = [snap({ tokenId: 'a', weight: 1 }), snap({ tokenId: 'b', weight: 1 })]
  const h = 'f'.repeat(64)
  check('same hash always selects the same entry', selectByHash(pool, h)?.tokenId === selectByHash(pool, h)?.tokenId)
  check('0x prefix is accepted', selectByHash(pool, '0x' + h)?.tokenId === selectByHash(pool, h)?.tokenId)
  check('short hash rejected', selectByHash(pool, 'abcd') === null)
  check('non-hex rejected', selectByHash(pool, 'z'.repeat(64)) === null)
  check('empty pool returns null', selectByHash([], h) === null)
  check('all-exhausted pool returns null', selectByHash([snap({ remaining: 0 })], h) === null)
}
{
  // Distribution: with a 90/10 split over many distinct hashes the observed
  // share must track the weights. This is the assertion that would catch an
  // off-by-one in the cumulative walk, which is exactly the bug that would
  // hand every player the same piece.
  const pool = [snap({ tokenId: 'heavy', weight: 90 }), snap({ tokenId: 'light', weight: 10 })]
  let heavy = 0
  const N = 4000
  for (let i = 0; i < N; i++) {
    const h = drawHash({ serverSeed: 'seed', txHash: '0xabc', unitIndex: 0, attempt: i })
    if (selectByHash(pool, h)?.tokenId === 'heavy') heavy++
  }
  const share = heavy / N
  check(`90/10 weights produce ~90% heavy (got ${(share * 100).toFixed(1)}%)`, share > 0.87 && share < 0.93)
}
{
  // Every entry must be reachable — an entry that can never be drawn is a lie
  // told by the odds table.
  const pool = [
    snap({ tokenId: 'x', weight: 1 }),
    snap({ tokenId: 'y', weight: 1 }),
    snap({ tokenId: 'z', weight: 1 }),
  ]
  const seen = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const h = drawHash({ serverSeed: 's', txHash: '0xdef', unitIndex: 0, attempt: i })
    const p = selectByHash(pool, h)
    if (p) seen.add(p.tokenId)
  }
  check('every entry is reachable', seen.size === 3, [...seen].join(','))
}
{
  // A single-entry pool is deterministic. Legitimate, but the odds table must
  // say 100% rather than imply chance that does not exist.
  const pool = [snap({ tokenId: 'only' })]
  check('single-entry pool always selects it', selectByHash(pool, 'a'.repeat(64))?.tokenId === 'only')
  check('single-entry odds read 1.0', deriveOdds(pool)[0].probability === 1)
}

// ─── 4. Snapshot mutation helpers ───────────────────────────────────────────
console.log('\n4. snapshot helpers')
{
  const pool = [snap({ tokenId: '1', remaining: 2 }), snap({ tokenId: '2', remaining: null })]
  const exc = withExcluded(pool, { collection: pool[0].collection, tokenId: '1' })
  check('exclusion removes exactly one entry', exc.length === 1 && exc[0].tokenId === '2')
  check('entryKey is lowercased and canonical', entryKey({ collection: '0xAABB', tokenId: '7' }) === '0xaabb:7')
}

// ─── 5. Solvency invariants ─────────────────────────────────────────────────
console.log('\n5. solvency')
const CREATOR = '0xcreator00000000000000000000000000000001'
const entry = (over: Partial<PoolEntry> = {}): PoolEntry => ({
  collection: '0xaaaa000000000000000000000000000000000001',
  tokenId: '1',
  artist: CREATOR,
  weight: 10,
  supply: 5,
  ...over,
})
/** Readable headroom for every key a fixture might use, all `null` — i.e. every
 *  pooled edition is itself an open edition, which is the only shape an
 *  unlimited (`supply: 0`) pledge is coherent against. An ABSENT key now means
 *  "the chain could not be read", which fails closed, so a fixture that means
 *  anything else must say so; the cases that actually exercise the cap override
 *  with a number. */
const AMPLE: Record<string, number | null> = Object.fromEntries(
  ['1', '2', '3', '9', 'f', 'c', 'a', 'b'].map((t) => [
    `0xaaaa000000000000000000000000000000000001:${t}`,
    null,
  ]),
)
/** Every declared artist holds ADMIN on their piece, for the same keys AMPLE
 *  covers. Like headroom, an ABSENT key means "the chain could not be read" and
 *  fails closed, so the cases that exercise the attestation override. */
const OWNED: Record<string, boolean> = Object.fromEntries(
  ['1', '2', '3', '9', 'f', 'c', 'a', 'b'].map((t) => [
    `0xaaaa000000000000000000000000000000000001:${t}`,
    true,
  ]),
)
/** The delivery account may mint every one of those pieces. Absent fails
 *  closed the same way. */
const GRANTED: Record<string, boolean> = Object.fromEntries(Object.keys(OWNED).map((k) => [k, true]))
const baseInput = {
  capsuleMaxSupply: 5,
  capsuleMinted: 0,
  entries: [entry()],
  splitRecipients: [CREATOR],
  creator: CREATOR,
  passCollection: null,
  headroom: { ...AMPLE } as Record<string, number | null>,
  otherPledges: {} as Record<string, number>,
  artistControl: { ...OWNED } as Record<string, boolean>,
  operatorGrant: { ...GRANTED } as Record<string, boolean>,
}
const codes = (p: ReturnType<typeof checkSolvency>) => p.map((x) => x.code)

check('a covered machine passes', checkSolvency(baseInput).length === 0)
check(
  'an entry whose on-chain headroom could not be read is REFUSED, not skipped',
  codes(checkSolvency({ ...baseInput, headroom: {} })).includes('headroom-unreadable'),
)
check(
  'an open edition reads as unlimited headroom, which is readable and fine',
  checkSolvency({
    ...baseInput,
    entries: [entry({ supply: 0, tokenId: 'f' })],
    capsuleMaxSupply: null,
  }).length === 0,
)
check('empty pool rejected', codes(checkSolvency({ ...baseInput, entries: [] })).includes('empty-pool'))
check(
  'undercollateralised rejected',
  codes(checkSolvency({ ...baseInput, capsuleMaxSupply: 10 })).includes('undercollateralised'),
)
check(
  'open-edition capsule without a floor piece rejected',
  codes(checkSolvency({ ...baseInput, capsuleMaxSupply: null })).includes('undercollateralised'),
)
check(
  'open-edition capsule WITH a creator floor piece passes',
  checkSolvency({
    ...baseInput,
    capsuleMaxSupply: null,
    entries: [entry({ supply: 0 })],
  }).length === 0,
)
check(
  'floor piece owned by someone else is rejected',
  codes(
    checkSolvency({
      ...baseInput,
      capsuleMaxSupply: null,
      entries: [entry({ supply: 0, artist: '0xother0000000000000000000000000000000001' })],
      splitRecipients: [CREATOR, '0xother0000000000000000000000000000000001'],
    }),
  ).includes('floor-not-creator'),
)
// A foreign open edition is a BONUS when capped pledges already cover the
// capsule supply — blocking it would reject a solvent machine. It is only a
// fault when the machine is actually leaning on it.
check(
  'foreign open edition alongside full capped coverage is allowed',
  checkSolvency({
    ...baseInput,
    capsuleMaxSupply: 5,
    entries: [entry({ supply: 5 }), entry({ tokenId: '9', supply: 0, artist: '0xother0000000000000000000000000000000001' })],
    splitRecipients: [CREATOR, '0xother0000000000000000000000000000000001'],
  }).length === 0,
)
check(
  'foreign open edition WITH a shortfall is flagged',
  codes(
    checkSolvency({
      ...baseInput,
      capsuleMaxSupply: 50,
      entries: [entry({ supply: 5 }), entry({ tokenId: '9', supply: 0, artist: '0xother0000000000000000000000000000000001' })],
      splitRecipients: [CREATOR, '0xother0000000000000000000000000000000001'],
    }),
  ).includes('floor-not-creator'),
)
check(
  'artist missing from the split is rejected',
  codes(
    checkSolvency({ ...baseInput, entries: [entry({ artist: '0xstranger000000000000000000000000000001' })] }),
  ).includes('artist-not-in-split'),
)
check(
  'duplicate entries rejected',
  codes(checkSolvency({ ...baseInput, entries: [entry(), entry()] })).includes('duplicate-entry'),
)
check(
  'bad weight rejected at publish',
  codes(checkSolvency({ ...baseInput, entries: [entry({ weight: 0 })] })).includes('bad-weight'),
)
check(
  'negative supply rejected',
  codes(checkSolvency({ ...baseInput, entries: [entry({ supply: -1 })] })).includes('bad-supply'),
)
check(
  'too many artists rejected',
  codes(
    checkSolvency({
      ...baseInput,
      capsuleMaxSupply: null,
      entries: Array.from({ length: MAX_POOL_ARTISTS + 1 }, (_, i) =>
        entry({ tokenId: String(i), artist: `0x${String(i).padStart(40, '0')}`, supply: 0 }),
      ),
      splitRecipients: Array.from({ length: MAX_POOL_ARTISTS + 1 }, (_, i) => `0x${String(i).padStart(40, '0')}`),
    }),
  ).includes('too-many-artists'),
)

// ── the artist named on an entry must be the token's admin ──────────────────
// The split check only ever asked "is the NAMED artist paid?"; nothing asked
// whether the name was true. A creator could pool a piece another artist had
// granted to the platform, name themselves as its artist, and pass.
check(
  'an entry whose declared artist does not hold admin is refused',
  codes(checkSolvency({ ...baseInput, artistControl: { ...OWNED, [entryKey(entry())]: false } }))
    .includes('artist-not-admin'),
)
check(
  'a piece the creator does not own is refused as not their own work',
  checkSolvency({ ...baseInput, artistControl: { ...OWNED, [entryKey(entry())]: false } })
    .some((p) => p.code === 'artist-not-admin' && p.detail.includes('your own work') && p.detail.includes(entryKey(entry()))),
)
check(
  'an entry naming someone else (a pool published before the own-work rule) names them',
  checkSolvency({
    ...baseInput,
    entries: [entry({ artist: '0xstranger000000000000000000000000000001' })],
    splitRecipients: [CREATOR, '0xstranger000000000000000000000000000001'],
    artistControl: { ...OWNED, [entryKey(entry())]: false },
  }).some((p) => p.code === 'artist-not-admin' && p.detail.includes('0xstranger000000000000000000000000000001')),
)
check(
  'an artist whose control could not be read is REFUSED, not skipped',
  codes(checkSolvency({ ...baseInput, artistControl: {} })).includes('artist-unreadable'),
)
check(
  'a false attestation is a separate finding from a missing split entry',
  (() => {
    const p = checkSolvency({
      ...baseInput,
      entries: [entry({ artist: '0xstranger000000000000000000000000000001' })],
      artistControl: { ...OWNED, [entryKey(entry())]: false },
    })
    return p.some((x) => x.code === 'artist-not-in-split') && p.some((x) => x.code === 'artist-not-admin')
  })(),
)

// The artist's consent, as the chain records it. A piece the delivery account
// cannot mint pends every play that draws it, so a machine leaning on it sells
// capsules it cannot honour. Found at publish, before anyone pays.
check(
  'a piece the delivery account may not mint is refused',
  codes(checkSolvency({ ...baseInput, operatorGrant: { ...GRANTED, [entryKey(entry())]: false } }))
    .includes('piece-not-allowed'),
)
check(
  'and the refusal tells the creator where the artist allows it',
  checkSolvency({ ...baseInput, operatorGrant: { ...GRANTED, [entryKey(entry())]: false } })
    .some((p) => p.code === 'piece-not-allowed' && p.detail.includes(`/artwork/${entry().collection}/${entry().tokenId}`)),
)
check(
  'a grant that could not be read is REFUSED, not skipped',
  codes(checkSolvency({ ...baseInput, operatorGrant: {} })).includes('allowance-unreadable'),
)

// THE hazard this whole subsystem must never permit. Prize delivery is an
// adminMint, which emits the same TransferSingle(0x0 -> player) the Pass
// webhook credits validity on — so a Pass artwork in a pool would turn a
// machine into a creator-credential vending machine.
console.log('\n5b. the Pass-collection block (G8)')
{
  const PASS = '0xpass0000000000000000000000000000000001'
  const problems = checkSolvency({
    ...baseInput,
    entries: [entry({ collection: PASS })],
    passCollection: PASS,
  })
  check('pass-collection artwork is rejected', codes(problems).includes('pass-collection'))
  check(
    'rejection is case-insensitive on the address',
    codes(
      checkSolvency({ ...baseInput, entries: [entry({ collection: PASS.toUpperCase() })], passCollection: PASS }),
    ).includes('pass-collection'),
  )
  check(
    'a non-pass collection is unaffected',
    !codes(checkSolvency({ ...baseInput, passCollection: PASS })).includes('pass-collection'),
  )
  check(
    'an unconfigured gate blocks nothing',
    !codes(checkSolvency({ ...baseInput, entries: [entry({ collection: PASS })], passCollection: null })).includes(
      'pass-collection',
    ),
  )
}

console.log('\n5c. cross-machine commitment ledger')
{
  const key = entryKey(entry())
  check(
    'pledging more than on-chain headroom is rejected',
    codes(checkSolvency({ ...baseInput, headroom: { ...AMPLE, [key]: 3 } })).includes('over-headroom'),
  )
  check(
    'another machine already pledging the headroom is rejected',
    codes(checkSolvency({ ...baseInput, headroom: { ...AMPLE, [key]: 5 }, otherPledges: { [key]: 3 } })).includes(
      'over-headroom',
    ),
  )
  check(
    'within headroom after other pledges passes',
    checkSolvency({ ...baseInput, headroom: { ...AMPLE, [key]: 10 }, otherPledges: { [key]: 3 } }).length === 0,
  )
  check(
    'an unlimited pledge on a CAPPED edition is rejected',
    codes(
      checkSolvency({ ...baseInput, capsuleMaxSupply: null, entries: [entry({ supply: 0 })], headroom: { ...AMPLE, [key]: 5 } }),
    ).includes('over-headroom'),
  )
}

console.log('\n5d. helpers')
check('findFloorPiece finds the creator open edition', !!findFloorPiece([entry({ supply: 0 })], CREATOR))
check('findFloorPiece ignores a capped entry', !findFloorPiece([entry({ supply: 3 })], CREATOR))
check('poolArtists dedupes case-insensitively', poolArtists([entry(), entry({ artist: CREATOR.toUpperCase() })]).length === 1)
{
  const c = coverage({ capsuleMaxSupply: 10, capsuleMinted: 4, remainingPrizes: 6 })
  check('coverage counts outstanding capsules', c.capsulesOutstanding === 6)
  check('exactly-covered reads covered', c.covered)
  check(
    'short coverage reads uncovered',
    !coverage({ capsuleMaxSupply: 10, capsuleMinted: 0, remainingPrizes: 3 }).covered,
  )
  check(
    'unlimited prizes are always covered',
    coverage({ capsuleMaxSupply: null, capsuleMinted: 0, remainingPrizes: null }).covered,
  )
}

console.log('\n5e. rarity by supply')
{
  const bySupply = { ...baseInput, rarity: 'supply' as const }
  check('a typed weight means nothing by supply', checkSolvency({ ...bySupply, entries: [entry({ weight: 0 })] }).length === 0)
  check(
    'but every piece needs copies — an unlimited one is refused',
    checkSolvency({ ...bySupply, capsuleMaxSupply: null, entries: [entry({ supply: 0 })] })
      .some((p) => p.code === 'bad-supply' && p.detail.includes('copies are its odds')),
  )
  check('as is a count past the weight bound', codes(checkSolvency({ ...bySupply, entries: [entry({ supply: MAX_WEIGHT + 1 })], headroom: { ...AMPLE } })).includes('bad-supply'))
  check('manual rarity still checks the weight', codes(checkSolvency({ ...baseInput, entries: [entry({ weight: 0 })] })).includes('bad-weight'))
  check(
    'an open capsule is told to cap at the copies in the machine',
    checkSolvency({ ...bySupply, capsuleMaxSupply: null, entries: [entry({ supply: 4 })] })
      .some((p) => p.code === 'undercollateralised' && p.detail.includes('cap it at 4')),
  )
  check(
    'a capsule capped within the copies passes',
    checkSolvency({ ...bySupply, capsuleMaxSupply: 5, entries: [entry({ supply: 5 })] }).length === 0,
  )
}

console.log('\n5f. reveal machine lineups')
{
  const A = { collection: '0xaaaa000000000000000000000000000000000001', tokenId: '1' }
  const B = { collection: '0xaaaa000000000000000000000000000000000001', tokenId: '2' }
  const artists = { [entryKey(A)]: '0xart0000000000000000000000000000000000001', [entryKey(B)]: '0xart0000000000000000000000000000000000002' }
  const lineup = (entries: typeof A[], over: Partial<Parameters<typeof checkLineup>[0]> = {}) =>
    checkLineup({ entries, artists, unavailable: new Set(), ...over })
  check('any artists’ pieces pass', lineup([A, B]).length === 0)
  check('an empty lineup is refused', codes(lineup([])).includes('empty-pool'))
  check('a piece twice is refused', codes(lineup([A, A])).includes('duplicate-entry'))
  check(
    'a piece Kismet has no maker for is refused',
    lineup([A], { artists: {} }).some((p) => p.code === 'artist-unknown' && p.detail.includes(entryKey(A))),
  )
  check(
    'a piece its artist turned off is refused',
    lineup([A, B], { unavailable: new Set([entryKey(B)]) }).some((p) => p.code === 'piece-unavailable' && p.detail.includes(entryKey(B))),
  )
  check('and only that piece', lineup([A, B], { unavailable: new Set([entryKey(B)]) }).length === 1)
  check(
    'too many pieces is refused',
    codes(lineup(Array.from({ length: 201 }, (_, i) => ({ ...A, tokenId: String(i) })), {
      artists: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${A.collection}:${i}`, '0xart0000000000000000000000000000000000001'])),
    })).includes('too-many-entries'),
  )
}

{
  // A linked collection is a lineup in itself, even before anything is minted.
  const lineup = (entries: { collection: string; tokenId: string }[], linked: boolean) =>
    checkLineup({ entries, artists: {}, unavailable: new Set(), linked })
  check('with a linked collection, no hand-picked pieces is allowed', lineup([], true).length === 0)
  check('without one, it is still refused', codes(lineup([], false)).includes('empty-pool'))
  check(
    'a linked collection excuses nothing else',
    codes(lineup([{ collection: '0xaaaa000000000000000000000000000000000001', tokenId: '1' }], true)).includes('artist-unknown'),
  )
}

console.log('\n5f2. the draw follows the chain (D1)')
{
  const A = snap({ tokenId: '1', remaining: 5 })
  const B = snap({ tokenId: '2', remaining: null, supply: 0 })
  const C = snap({ tokenId: '3', remaining: 4 })
  const D = snap({ tokenId: '4', remaining: 3 })
  const standing = {
    [entryKey(A)]: { left: 2, granted: true },    // fewer copies on-chain than pledged
    [entryKey(B)]: { left: 7, granted: true },    // unlimited pledge, capped edition
    [entryKey(C)]: { left: 0, granted: true },    // sold out on-chain
    [entryKey(D)]: { left: null, granted: false }, // grant revoked
  }
  const live = withLiveStanding([A, B, C, D], standing)
  check('a sold-out piece leaves the table', !live.some((e) => e.tokenId === '3'))
  check('a piece whose grant was revoked leaves it', !live.some((e) => e.tokenId === '4'))
  check('what remains keeps its order (selection walks it)', live.map((e) => e.tokenId).join(',') === '1,2')
  check('a pledge is clamped to the copies that exist', live[0]?.remaining === 2)
  check('an unlimited pledge takes the edition’s own limit', live[1]?.remaining === 7)
  check('an open edition keeps the pledge', withLiveStanding([A], { [entryKey(A)]: { left: null, granted: true } })[0]?.remaining === 5)
  check('and open on both sides stays unlimited', withLiveStanding([B], { [entryKey(B)]: { left: null, granted: true } })[0]?.remaining === null)
  check('more copies on-chain never raise a pledge', withLiveStanding([A], { [entryKey(A)]: { left: 99, granted: true } })[0]?.remaining === 5)
  check('a piece with no reading is dropped, not assumed', withLiveStanding([A, B], { [entryKey(B)]: { left: 1, granted: true } }).map((e) => e.tokenId).join(',') === '2')
  check('nothing readable, nothing drawable', withLiveStanding([A, B], {}).length === 0)
  check('the input snapshot is not modified', A.remaining === 5 && B.remaining === null)
  const odds = deriveOdds(live)
  check('the published odds cover only what can be delivered', odds.length === 2 && Math.abs(odds.reduce((t, o) => t + o.probability, 0) - 1) < 1e-12)
}

console.log('\n5g. a reveal pull is uniform')
{
  const n = 3
  const counts = [0, 0, 0]
  let inRange = true
  for (let i = 0; i < 30_000; i++) {
    const k = pickIndex(n)
    if (!Number.isInteger(k) || k < 0 || k >= n) inRange = false
    else counts[k]++
  }
  check('every pull lands on a piece in the lineup', inRange)
  // Each share within 3 points of a third: over ten standard deviations for a
  // fair pick, which essentially never fails it; a biased or constant one does.
  check('and each piece comes up about 1 in 3', counts.every((c) => Math.abs(c / 30_000 - 1 / 3) < 0.03), counts.join(','))
  check('a one-piece lineup always reveals it', Array.from({ length: 50 }, () => pickIndex(1)).every((k) => k === 0))
}

console.log('\n5h. who earns the mint referral')
{
  const { KISMET_REFERRAL, buildEthMintCall, buildUsdcMintCall, resolveMintReferral } = await import('../lib/zoraMint.ts')
  const { planPayouts, payoutAddresses, withdrawForCall, PROTOCOL_REWARDS } = await import('../lib/referralPayouts.ts')
  const { toFunctionSelector } = await import('viem')
  const CURATOR = '0x7777000000000000000000000000000000007777'
  const PLAYER = '0x51be09ac3e7d21f48b6a0c5d9e2f7b3a1c8d77aa'
  check('a reveal machine\'s curator earns it', resolveMintReferral(CURATOR, [PLAYER]).toLowerCase() === CURATOR)
  check('Kismet does when no curator is named', resolveMintReferral(null, [PLAYER]) === KISMET_REFERRAL && resolveMintReferral(undefined, [PLAYER]) === KISMET_REFERRAL)
  check('or the value is not an address', resolveMintReferral('0xnope', [PLAYER]) === KISMET_REFERRAL)
  check('a curator collecting from their own machine earns no rebate on it', resolveMintReferral(CURATOR, [CURATOR.toUpperCase().replace('0X', '0x')]) === KISMET_REFERRAL)
  check('nor when gifting to themselves', resolveMintReferral(CURATOR, [PLAYER, CURATOR]) === KISMET_REFERRAL)
  const eth = (referral?: `0x${string}`) =>
    buildEthMintCall({ tokenId: 1n, mintTo: PLAYER as `0x${string}`, quantity: 1n, mintFee: 1n, pricePerToken: 2n, comment: '', referral })
  const usdc = (referral?: `0x${string}`) =>
    buildUsdcMintCall({ collection: CURATOR as `0x${string}`, tokenId: 1n, mintTo: PLAYER as `0x${string}`, quantity: 1n, pricePerToken: 2n, comment: '', referral })
  check('an ETH collect names Kismet unless told otherwise', eth().args[3][0] === KISMET_REFERRAL && eth(CURATOR as `0x${string}`).args[3][0] === CURATOR)
  check('and so does a USDC collect', usdc().args[6] === KISMET_REFERRAL && usdc(CURATOR as `0x${string}`).args[6] === CURATOR)

  const MIN = 50_000_000_000_000n
  const plan = planPayouts([
    { address: 'a', balance: MIN - 1n },
    { address: 'b', balance: MIN },
    { address: 'c', balance: 10n * MIN },
  ], MIN, 25)
  check('a payout waits until it is worth sending, and the largest goes first', plan.map((p) => p.address).join(',') === 'c,b')
  check('one run is bounded', planPayouts(Array.from({ length: 40 }, (_, i) => ({ address: String(i), balance: MIN })), MIN, 25).length === 25)
  const addrs = payoutAddresses([CURATOR, CURATOR.toUpperCase().replace('0X', '0x'), KISMET_REFERRAL])
  check('Kismet and every curator are checked, once each', addrs.length === 2 && addrs[0] === KISMET_REFERRAL.toLowerCase() && addrs[1] === CURATOR)
  const call = withdrawForCall(CURATOR)
  check('a payout is withdrawFor(owner, everything) on Zora\'s rewards contract',
    call.to === PROTOCOL_REWARDS && call.data.startsWith(toFunctionSelector('withdrawFor(address,uint256)')) &&
      call.data.toLowerCase().includes(CURATOR.slice(2)) && call.data.endsWith('0'.repeat(64)))
}

// ─── 6. Fairness: commit–reveal, and the weight-table commitment ────────────
console.log('\n6. fairness')
{
  const seed = 'a'.repeat(64)
  check('commitment is stable', commitmentFor(seed) === commitmentFor(seed))
  check('commitment changes with the seed', commitmentFor(seed) !== commitmentFor('b'.repeat(64)))
  check('commitment is 32-byte hex', /^[0-9a-f]{64}$/.test(commitmentFor(seed)))

  const s1 = [snap({ tokenId: '1' }), snap({ tokenId: '2', weight: 3 })]
  check('snapshot hash is stable', snapshotHash(s1) === snapshotHash(s1))
  // The whole reason the weight table is committed: a changed weight MUST
  // produce a different hash, or odds could be altered silently between rounds
  // while every individual draw still verified.
  check(
    'a changed WEIGHT changes the snapshot hash',
    snapshotHash(s1) !== snapshotHash([snap({ tokenId: '1' }), snap({ tokenId: '2', weight: 4 })]),
  )
  check(
    'a changed REMAINING changes the snapshot hash',
    snapshotHash(s1) !== snapshotHash([snap({ tokenId: '1', remaining: 4 }), snap({ tokenId: '2', weight: 3 })]),
  )
  check(
    'canonical form is case-insensitive on addresses',
    canonicalSnapshot([snap({ collection: '0xAB', artist: '0xCD' })]) ===
      canonicalSnapshot([snap({ collection: '0xab', artist: '0xcd' })]),
  )
  check('unlimited remaining serialises distinctly', canonicalSnapshot([snap({ remaining: null })]).includes('|open'))

  const args = { serverSeed: seed, txHash: '0xFEED', unitIndex: 0, attempt: 0 }
  check('draw hash is deterministic', drawHash(args) === drawHash(args))
  check('txHash case does not change the draw', drawHash(args) === drawHash({ ...args, txHash: '0xfeed' }))
  check('unitIndex changes the draw', drawHash(args) !== drawHash({ ...args, unitIndex: 1 }))
  check('attempt changes the draw', drawHash(args) !== drawHash({ ...args, attempt: 1 }))
  check('seed changes the draw', drawHash(args) !== drawHash({ ...args, serverSeed: 'b'.repeat(64) }))

  const good = verifyDraw({
    serverSeed: seed,
    commitment: commitmentFor(seed),
    snapshot: s1,
    snapshotHash: snapshotHash(s1),
    txHash: '0xfeed',
    unitIndex: 0,
    attempt: 0,
  })
  check('a well-formed draw verifies', good.ok)
  check('verification returns the recomputed hash', good.hash === drawHash({ ...args, txHash: '0xfeed' }))

  check(
    'a wrong seed fails verification',
    !verifyDraw({
      serverSeed: 'c'.repeat(64),
      commitment: commitmentFor(seed),
      snapshot: s1,
      snapshotHash: snapshotHash(s1),
      txHash: '0xfeed',
      unitIndex: 0,
      attempt: 0,
    }).ok,
  )
  // The check the industry omits, and the reason "provably fair" has been
  // shipped over rigged tables: a valid seed with a SWAPPED TABLE must fail.
  const tampered = [snap({ tokenId: '1' }), snap({ tokenId: '2', weight: 999 })]
  check(
    'a valid seed with a tampered weight table FAILS',
    !verifyDraw({
      serverSeed: seed,
      commitment: commitmentFor(seed),
      snapshot: tampered,
      snapshotHash: snapshotHash(s1),
      txHash: '0xfeed',
      unitIndex: 0,
      attempt: 0,
    }).ok,
  )
}
{
  check('epoch is a UTC date label', epochFor(Date.parse('2026-09-01T23:59:59Z')) === '2026-09-01')
  check('epoch rolls at UTC midnight', epochFor(Date.parse('2026-09-02T00:00:00Z')) === '2026-09-02')
  check(
    'epochs order lexicographically (the reveal guard relies on it)',
    epochFor(Date.parse('2026-09-01T00:00:00Z')) < epochFor(Date.parse('2026-09-02T00:00:00Z')),
  )
}

// ─── 7. End-to-end: a play is reproducible from published material ──────────
console.log('\n7. end-to-end reproducibility')
{
  // Exactly what a sceptical player does with a published receipt: take the
  // revealed seed, the published snapshot, and their own txHash, and land on
  // the same artwork the machine said they won.
  const seed = 'deadbeef'.repeat(8)
  const pool = [
    snap({ tokenId: '1', weight: 50 }),
    snap({ tokenId: '2', weight: 30 }),
    snap({ tokenId: '3', weight: 20 }),
  ]
  const tx = '0x' + '1'.repeat(64)
  const serverPick = selectByHash(pool, drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt: 0 }))

  const v = verifyDraw({
    serverSeed: seed,
    commitment: commitmentFor(seed),
    snapshot: pool,
    snapshotHash: snapshotHash(pool),
    txHash: tx,
    unitIndex: 0,
    attempt: 0,
  })
  const playerPick = v.ok && v.hash ? selectByHash(pool, v.hash) : null
  check('verifier reproduces the machine result', !!serverPick && playerPick?.tokenId === serverPick.tokenId)

  // A redraw is separately verifiable rather than opaque.
  const second = selectByHash(
    withExcluded(pool, { collection: serverPick!.collection, tokenId: serverPick!.tokenId }),
    drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt: 1 }),
  )
  check('a redraw never returns the excluded piece', second?.tokenId !== serverPick!.tokenId)
  check('a redraw still returns something', !!second)
}

// ─── 7a. A redraw is verifiable from public material ────────────────────────
console.log('\n7a. the verifier replays the draw loop, redraws included')
{
  // The property that makes a redraw checkable: whatever the draw loop
  // delivered at attempt N, replaying attempts 0..N from the snapshot and the
  // seed alone lands on the same piece and names the same set-aside pieces.
  // Randomised over seeds and refusal patterns, because the defect it pins
  // (recomputing the last attempt over the WHOLE table) passed every attempt-0
  // case and failed most redraws.
  const pool = [
    snap({ tokenId: '1', weight: 50 }),
    snap({ tokenId: '2', weight: 30 }),
    snap({ tokenId: '3', weight: 15 }),
    snap({ tokenId: '4', weight: 5 }),
  ]
  let plays = 0
  let agreed = 0
  let wholeTableAgreed = 0
  for (let i = 0; i < 400; i++) {
    const seed = createHashHex(`seed-${i}`)
    const tx = '0x' + createHashHex(`tx-${i}`)
    const refusals = i % 4
    let seen = 0
    const hashAt = (a: number) => drawHash({ serverSeed: seed, txHash: tx, unitIndex: 0, attempt: a })
    const res = await runDraw(pool, {
      consume: async () => null,
      release: async () => {},
      authority: async () => seen++ >= refusals,
      hash: hashAt,
    })
    if (res.kind !== 'drawn') continue
    plays++
    const replay = drawAtAttempt(pool, hashAt, res.attempt)
    if (
      replay.pick?.tokenId === res.prize.tokenId &&
      replay.setAside.length === res.attempt &&
      !replay.setAside.some((e) => e.tokenId === res.prize.tokenId)
    ) agreed++
    if (selectByHash(pool, hashAt(res.attempt))?.tokenId === res.prize.tokenId) wholeTableAgreed++
  }
  check('every drawn play replays to the delivered piece', plays === 400 && agreed === plays, `${agreed}/${plays}`)
  check('recomputing only the last attempt over the whole table does not (the pinned defect)', wholeTableAgreed < plays)
  const none = drawAtAttempt([], (a) => drawHash({ serverSeed: 's', txHash: '0x1', unitIndex: 0, attempt: a }), 2)
  check('an empty table replays to nothing', none.pick === null && none.setAside.length === 0)
}

// ─── 7b. Liability is what can still be SOLD ────────────────────────────────
console.log('\n7b. outstanding nets off already-minted capsules')
{
  const floor = entry({ tokenId: 'f', supply: 0, artist: CREATOR })
  const capped = entry({ tokenId: 'c', supply: 40 })
  const base = {
    entries: [capped],
    splitRecipients: [CREATOR, capped.artist],
    creator: CREATOR,
    passCollection: null,
    headroom: { ...AMPLE },
    otherPledges: {},
    artistControl: { ...OWNED },
    operatorGrant: { ...GRANTED },
  }
  // 100-cap capsule with 70 already minted: only 30 can still be sold, so 40
  // pledged copies cover it. The gate used to demand coverage for all 100 while
  // the machine page's own coverage() figure subtracted — the two disagreed.
  check('a mostly-minted capsule is solvent against what remains',
    checkSolvency({ ...base, capsuleMaxSupply: 100, capsuleMinted: 70 }).length === 0)
  check('and the same pool is NOT solvent when nothing has been minted yet',
    checkSolvency({ ...base, capsuleMaxSupply: 100, capsuleMinted: 0 })
      .some((p) => p.code === 'undercollateralised'))
  check('the gate now agrees with the coverage figure players see',
    coverage({ capsuleMaxSupply: 100, capsuleMinted: 70, remainingPrizes: 40 }).covered ===
      (checkSolvency({ ...base, capsuleMaxSupply: 100, capsuleMinted: 70 }).length === 0))
  check('an exhausted capsule owes nothing further',
    checkSolvency({ ...base, capsuleMaxSupply: 100, capsuleMinted: 100, entries: [entry({ tokenId: 'c', supply: 1 })] })
      .filter((p) => p.code === 'undercollateralised').length === 0)
  check('a minted count above the cap cannot invert the bound',
    checkSolvency({ ...base, capsuleMaxSupply: 10, capsuleMinted: 999 })
      .filter((p) => p.code === 'undercollateralised').length === 0)
  check('an open-edition capsule still requires a creator floor',
    checkSolvency({ ...base, capsuleMaxSupply: null, capsuleMinted: 0 })
      .some((p) => p.code === 'undercollateralised'))
  check('which a creator floor satisfies',
    checkSolvency({ ...base, entries: [capped, floor], capsuleMaxSupply: null, capsuleMinted: 0 }).length === 0)
}

// ─── 8. Odds formatting: never round a real chance down to nothing ───────────
console.log('\n8. odds formatting')
{
  // THE REGRESSION THIS PINS. `(p * 100).toFixed(1)` renders a live 0.04% prize
  // as "0.0%" — a statement that a winnable piece cannot be won, on the one
  // surface whose entire job is an accurate disclosure. Every positive
  // probability must render as visibly positive.
  const tiny = [0.0004, 0.00004, 0.000004, 1e-7, 1e-9]
  check(
    'no positive probability ever renders as 0%',
    tiny.every((p) => formatProbability(p) !== '0%' && formatProbability(p) !== '0.0%'),
    tiny.map((p) => `${p}->${formatProbability(p)}`).join(' '),
  )
  check('an impossible row does render as 0%', formatProbability(0) === '0%')
  check('and so does a negative or broken one', formatProbability(NaN) === '0%' && formatProbability(-1) === '0%')

  check('precision scales with magnitude (big)', formatProbability(0.5) === '50.0%')
  check('precision scales with magnitude (mid)', formatProbability(0.025) === '2.50%')
  check('precision scales with magnitude (small)', formatProbability(0.0004) === '0.040%')
  check('below a thousandth of a percent degrades to an inequality, not a zero',
    formatProbability(0.0000004) === '<0.001%')
  check('certainty reads as 100%', formatProbability(1) === '100%')

  check('the ratio form carries the figure a percentage rounds away',
    formatOddsRatio(0.0004) === '1 in 2,500')
  check('a certain row has no meaningful ratio', formatOddsRatio(1) === null)
  check('nor does an impossible one', formatOddsRatio(0) === null)
  check('ratio rounds to the nearest whole draw', formatOddsRatio(0.5) === '1 in 2')

  check('unlimited supply reads as a word, not a glyph', formatRemaining(null) === 'unlimited')
  check('one copy is singular', formatRemaining(1) === '1 left')
  check('many copies are grouped', formatRemaining(12345) === '12,345 left')
  check('exhausted reads as zero left', formatRemaining(0) === '0 left')

  check('a titled artwork uses its title', artworkTitle('Dawn Chorus', '7') === 'Dawn Chorus')
  check('an untitled one falls back to its token id', artworkTitle(null, '7') === '#7')
  check('and whitespace is not a title', artworkTitle('   ', '7') === '#7')

  // The formatter must agree with the table it formats: every drawable row in a
  // real derived table renders as non-zero.
  const table = deriveOdds([
    snap({ tokenId: 'a', weight: 999_999 }),
    snap({ tokenId: 'b', weight: 1 }),
  ])
  check('a 1-in-a-million row still renders visibly',
    formatProbability(table[1].probability) !== '0%' && formatProbability(table[1].probability) !== '0.0%',
    formatProbability(table[1].probability))
}

// ─── 9. Epoch arithmetic: seeds must be committable a day ahead ──────────────
console.log('\n9. epoch arithmetic')
{
  check('an ordinary day advances', nextEpoch('2026-03-01') === '2026-03-02')
  check('a month rolls over', nextEpoch('2026-01-31') === '2026-02-01')
  check('a year rolls over', nextEpoch('2025-12-31') === '2026-01-01')
  check('a leap day exists in a leap year', nextEpoch('2028-02-28') === '2028-02-29')
  check('and does not in a common year', nextEpoch('2026-02-28') === '2026-03-01')
  check('nextEpoch agrees with epochFor across the boundary',
    nextEpoch(epochFor(Date.UTC(2026, 5, 30, 23, 59, 59))) === '2026-07-01')
  check('epochs sort lexicographically, which revealSeed relies on',
    '2026-01-31' < nextEpoch('2026-01-31') && nextEpoch('2025-12-31') > '2025-12-31')
}

// ─── the studio reads a lineup from pasted links ─────────────────────────────
console.log('\nstudio: artwork references')
{
  const C = '0xAbCdEf0000000000000000000000000000000001'
  const want = (r: ReturnType<typeof parseArtworkRef>) => r?.collection === C.toLowerCase() && r.tokenId === '12'
  check('a full artwork link', want(parseArtworkRef(`https://kismet.art/artwork/${C}/12`)))
  check('with a query or fragment after it', want(parseArtworkRef(`https://kismet.art/artwork/${C}/12?ref=feed#top`)))
  check('its path alone', want(parseArtworkRef(`/artwork/${C}/12`)))
  check('an address and id with a slash or a colon', want(parseArtworkRef(`${C}/12`)) && want(parseArtworkRef(`${C}:12`)))
  check('the token id is canonical, as every key is', parseArtworkRef(`${C}/012`)?.tokenId === '12')
  check('a bare address is not a piece', parseArtworkRef(C) === null)
  check('nor is anything else', parseArtworkRef('https://kismet.art/experience') === null && parseArtworkRef('') === null)
}

console.log(
  failures > 0 ? `\n${failures} FAILURE(S)\n` : '\nAll experience invariants hold.\n',
)
if (failures > 0) process.exit(1)
