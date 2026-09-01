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

import {
  MAX_POOL_ARTISTS,
  MAX_WEIGHT,
  deriveOdds,
  eligible,
  entryKey,
  isDrawable,
  oddsAreCoherent,
  poolArtists,
  selectByHash,
  totalWeight,
  withDecrement,
  withExcluded,
} from '../lib/experience/draw.ts'
import { checkSolvency, coverage, findFloorPiece, pledgedSupply } from '../lib/experience/solvency.ts'
import {
  canonicalSnapshot,
  commitmentFor,
  drawHash,
  epochFor,
  snapshotHash,
  verifyDraw,
} from '../lib/experience/fairness.ts'
import type { PoolEntry, SnapshotEntry } from '../lib/experience/types.ts'

let failures = 0
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
  const dec = withDecrement(pool, { collection: pool[0].collection, tokenId: '1' })
  check('decrement reduces the target', dec[0].remaining === 1)
  check('decrement never goes negative', withDecrement(withDecrement(dec, { collection: pool[0].collection, tokenId: '1' }), { collection: pool[0].collection, tokenId: '1' })[0].remaining === 0)
  check('unlimited entry is untouched by decrement', dec[1].remaining === null)
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
const baseInput = {
  capsuleMaxSupply: 5,
  capsuleMinted: 0,
  entries: [entry()],
  splitRecipients: [CREATOR],
  creator: CREATOR,
  passCollection: null,
  headroom: {} as Record<string, number | null>,
  otherPledges: {} as Record<string, number>,
}
const codes = (p: ReturnType<typeof checkSolvency>) => p.map((x) => x.code)

check('a covered machine passes', checkSolvency(baseInput).length === 0)
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
    codes(checkSolvency({ ...baseInput, headroom: { [key]: 3 } })).includes('over-headroom'),
  )
  check(
    'another machine already pledging the headroom is rejected',
    codes(checkSolvency({ ...baseInput, headroom: { [key]: 5 }, otherPledges: { [key]: 3 } })).includes(
      'over-headroom',
    ),
  )
  check(
    'within headroom after other pledges passes',
    checkSolvency({ ...baseInput, headroom: { [key]: 10 }, otherPledges: { [key]: 3 } }).length === 0,
  )
  check(
    'an unlimited pledge on a CAPPED edition is rejected',
    codes(
      checkSolvency({ ...baseInput, capsuleMaxSupply: null, entries: [entry({ supply: 0 })], headroom: { [key]: 5 } }),
    ).includes('over-headroom'),
  )
}

console.log('\n5d. helpers')
check('pledgedSupply sums capped entries', pledgedSupply([entry({ supply: 2 }), entry({ supply: 3 })]) === 5)
check('pledgedSupply is null when any entry is unlimited', pledgedSupply([entry({ supply: 0 })]) === null)
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

console.log(
  failures > 0 ? `\n${failures} FAILURE(S)\n` : '\nAll experience invariants hold.\n',
)
if (failures > 0) process.exit(1)
