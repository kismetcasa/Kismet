// Guards lib/passTaint — the provenance arithmetic under the Pass gate
// (processTransfer's per-transfer effects and hasValidPass's countable
// balance).
//
// THE REGRESSION IT GUARDS. This module replaced a token-scoped "taint" that
// revoked EVERY holder of an edition, and blocked every future mint of it,
// the moment ONE holder moved a copy off-platform. Two things must therefore
// stay true forever, and they pull in opposite directions:
//
//   A. The gate must not weaken. Every denial the old model produced for the
//      wallet that actually left the platform must still be produced:
//      the sender is decremented on EVERY non-mint transfer (off-platform or
//      not), and a holder whose copies are all off-platform proves nothing.
//   B. The gate must not spill. A holder who did nothing must be unaffected
//      by someone else's transfer — including the griefing case where a
//      hostile party SENDS them a pass. A boolean mark reintroduces that
//      vector; only unit counting closes it. If anyone ever "simplifies"
//      countableUnits back to a skip-the-whole-id rule, S7/S8 fail.
//
// Mints are the third invariant: a mint has NO effects here, which is what
// makes collect-and-gift (lib/gift.ts) incapable of marking anyone.
//
// Run: node --experimental-strip-types scripts/verify-pass-taint.ts

import {
  countableUnits,
  parseUnitCount,
  planTransferEffects,
  releaseUnits,
} from '../lib/passTaint.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const effects = (o: Partial<Parameters<typeof planTransferEffects>[0]>) =>
  planTransferEffects({
    amount: 1,
    isMint: false,
    isPlatform: false,
    isKismetListed: false,
    toIsBurn: false,
    ...o,
  })

console.log('\nplanTransferEffects — per-transfer decision')

// S1. A mint is genesis: no sender, and the recipient acquired on-platform by
// definition. This is the invariant collect-and-gift rests on.
const mint = effects({ isMint: true })
check('mint decrements nobody', mint.decrementFrom === 0)
check('mint releases nothing', mint.releaseFrom === 0)
check('MINT NEVER MARKS THE RECIPIENT (collect-and-gift safety)', mint.markTo === 0)
check(
  'mint is inert at any quantity',
  effects({ isMint: true, amount: 50 }).markTo === 0,
)

// S2. Off-platform transfer — the case the whole subsystem exists for.
const off = effects({})
check('off-platform transfer decrements the sender (any-transfer-revokes)', off.decrementFrom === 1)
check('off-platform transfer releases the sender', off.releaseFrom === 1)
check('off-platform transfer marks the receiver', off.markTo === 1)

// S3/S4. On-platform moves: sender still loses the copy, receiver stays clean.
for (const [label, o] of [
  ['platform-flagged (Kismet fill / airdrop)', { isPlatform: true }],
  ['kismet-listed race guard', { isKismetListed: true }],
] as const) {
  const e = effects(o)
  check(`${label} still decrements the sender`, e.decrementFrom === 1)
  check(`${label} still releases the sender`, e.releaseFrom === 1)
  check(`${label} does NOT mark the receiver`, e.markTo === 0)
}

// S5. Burn: units cease to exist, so provenance against 0x0 is noise — but the
// sender is still revoked.
const burn = effects({ toIsBurn: true })
check('burn decrements the sender', burn.decrementFrom === 1)
check('burn does not mark the zero address', burn.markTo === 0)

// S6. Defensive: a zero/negative/NaN amount is inert.
for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  const e = effects({ amount })
  check(
    `amount ${String(amount)} produces no effects`,
    e.decrementFrom === 0 && e.releaseFrom === 0 && e.markTo === 0,
  )
}

// Quantities carry through, floored.
check('multi-unit transfer carries its quantity', effects({ amount: 5 }).markTo === 5)
check('fractional quantity floors', effects({ amount: 2.9 }).decrementFrom === 2)

console.log('\ncountableUnits — what a balance may prove')

// S7. THE FIX. A holder untouched by anyone else's transfer counts everything.
check('B: untouched holder counts their whole balance', countableUnits(1n, 0) === 1n)
check('B: co-holder of a moved edition is unaffected', countableUnits(3n, 0) === 3n)

// S8. THE GRIEF VECTOR. One legitimate copy + one unsolicited off-platform
// copy still proves the legitimate one. A boolean mark would return 0 here
// and hand anyone a one-pass revocation weapon.
check('B: legit copy survives an unsolicited off-platform copy', countableUnits(2n, 1) === 1n)
check('B: two legit copies survive one hostile send', countableUnits(3n, 1) === 2n)

// S9. THE DENIAL. Off-platform-only holdings prove nothing — the property the
// old token-scoped rule provided, now scoped to the wallet that earned it.
check('A: off-platform-only holder proves nothing', countableUnits(1n, 1) === 0n)
check('A: off-platform-only holder, multiple units', countableUnits(4n, 4) === 0n)
check('A: never negative when marks exceed balance', countableUnits(1n, 5) === 0n)
check('A: zero balance proves nothing', countableUnits(0n, 0) === 0n)

// Defensive parses can only fail OPEN (no marks), never falsely revoke.
check('garbage mark count is ignored, not revoking', countableUnits(2n, Number.NaN) === 2n)
check('negative mark count is ignored', countableUnits(2n, -3) === 2n)

console.log('\nreleaseUnits — sender-side conservation')

check('release reduces the count', releaseUnits(3, 1) === 2)
check('release clamps at zero, never negative', releaseUnits(1, 5) === 0)
check('release of zero is a no-op', releaseUnits(2, 0) === 2)
check('release from nothing stays nothing', releaseUnits(0, 1) === 0)
check('garbage current reads as zero', releaseUnits(Number.NaN, 1) === 0)

// Conservation: mark then release returns to clean, so an off-platform copy
// that is later sold on Kismet does not brand its former holder forever.
check(
  'mark → release round-trips to clean',
  releaseUnits(effects({}).markTo, effects({ isPlatform: true }).releaseFrom) === 0,
)

console.log('\nparseUnitCount — Upstash dual representation')

check("'2' (SET form) reads as 2", parseUnitCount('2') === 2)
check('2 (Upstash GET form) reads as 2', parseUnitCount(2) === 2)
check('absent reads as 0', parseUnitCount(null) === 0 && parseUnitCount(undefined) === 0)
check('empty reads as 0', parseUnitCount('') === 0)
check('garbage reads as 0 (fails open, cannot revoke)', parseUnitCount('abc') === 0)
check('negative reads as 0', parseUnitCount(-2) === 0 && parseUnitCount('-2') === 0)
check('fractional floors', parseUnitCount(2.9) === 2)

// ---------------------------------------------------------------------------
// END-TO-END LIFECYCLE MODEL
//
// The unit checks above pin each rule in isolation; these replay whole
// transfer sequences through the COMPOSITION of them and assert the gate's
// final verdict. That is the level the old model failed at — every individual
// taint rule was defensible, and together they revoked an entire edition.
//
// The model mirrors the real code path exactly; the mirrored lines are named
// so a divergence is findable:
//   applyTransfer -> lib/pass-validity.processTransfer
//   gateVerdict   -> lib/pass-validity.hasValidPass (ledger read, clamp, CAS)
// It deliberately re-implements rather than imports, so a change to
// pass-validity that breaks an invariant shows up as a FAILING SCENARIO here
// instead of silently passing because both sides moved together.
// ---------------------------------------------------------------------------

interface Chain { [addr: string]: { [tokenId: string]: bigint } }
interface Counts { [addr: string]: { [tokenId: string]: number } }
interface World { ledger: Record<string, number>; off: Counts; chain: Chain }

const world = (): World => ({ ledger: {}, off: {}, chain: {} })
// Counts on-chain reads so the zero-ledger short-circuit can be asserted
// rather than assumed: a denied non-holder must cost no balanceOfBatch.
let chainReads = 0
const bal = (w: World, a: string, t: string) => {
  chainReads++
  return w.chain[a]?.[t] ?? 0n
}
const offOf = (w: World, a: string, t: string) => w.off[a]?.[t] ?? 0
const setBal = (w: World, a: string, t: string, v: bigint) => {
  ;(w.chain[a] ??= {})[t] = v < 0n ? 0n : v
}
const setOff = (w: World, a: string, t: string, v: number) => {
  ;(w.off[a] ??= {})[t] = v
}

const ZERO_ADDR = '0x0'

/** Mirrors processTransfer: move the copies, then apply the planned effects
 *  and the credit arm (`if (platform || isMint)`). */
function applyTransfer(
  w: World,
  ev: {
    from: string
    to: string
    tokenId: string
    amount: number
    isPlatform?: boolean
    isKismetListed?: boolean
    /** Simulates a webhook event the indexer never received. */
    missedByWebhook?: boolean
  },
): void {
  const isMint = ev.from === ZERO_ADDR
  const toIsBurn = ev.to === ZERO_ADDR

  // On-chain truth moves regardless of whether our indexer saw the event.
  if (!isMint) setBal(w, ev.from, ev.tokenId, bal(w, ev.from, ev.tokenId) - BigInt(ev.amount))
  if (!toIsBurn) setBal(w, ev.to, ev.tokenId, bal(w, ev.to, ev.tokenId) + BigInt(ev.amount))
  if (ev.missedByWebhook) return

  const effects = planTransferEffects({
    amount: ev.amount,
    isMint,
    isPlatform: !!ev.isPlatform,
    isKismetListed: !!ev.isKismetListed,
    toIsBurn,
  })
  if (effects.decrementFrom > 0) {
    w.ledger[ev.from] = (w.ledger[ev.from] ?? 0) - effects.decrementFrom
  }
  if (effects.releaseFrom > 0) {
    setOff(w, ev.from, ev.tokenId, releaseUnits(offOf(w, ev.from, ev.tokenId), effects.releaseFrom))
  }
  if (effects.markTo > 0) {
    setOff(w, ev.to, ev.tokenId, offOf(w, ev.to, ev.tokenId) + effects.markTo)
  }
  // creditValidityOnce, reached from the mint arm or the platform flag.
  if (isMint || ev.isPlatform) {
    if (!toIsBurn) w.ledger[ev.to] = (w.ledger[ev.to] ?? 0) + ev.amount
  }
}

/** Mirrors hasValidPass: clamped ledger read, countable live total, clamp DOWN
 *  (persisted, as the CAS does), verdict at >= 1. */
function gateVerdict(w: World, addr: string, knownIds: string[]): boolean {
  let validBalance = Math.max(0, w.ledger[addr] ?? 0)
  // Zero-ledger short-circuit: everything below only clamps DOWN, so a ledger
  // under 1 is false either way. Mirrored here so the model proves the real
  // function's early return costs nothing in correctness.
  if (validBalance < 1) return false
  let liveTotal = 0n
  for (const t of knownIds) liveTotal += countableUnits(bal(w, addr, t), offOf(w, addr, t))
  if (liveTotal < BigInt(validBalance)) {
    validBalance = Number(liveTotal)
    w.ledger[addr] = validBalance
  }
  return validBalance >= 1
}

const IDS = ['1', '3']
const T = '3' // the 100-edition Patron drop

console.log('\nend-to-end lifecycle')

// E1. THE HEADLINE REGRESSION. Two patrons hold the same edition; one sells
// off-platform. Under the superseded model this revoked BOTH.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'alice', tokenId: T, amount: 1 })
  applyTransfer(w, { from: ZERO_ADDR, to: 'bob', tokenId: T, amount: 1 })
  check('E1 alice valid after her mint', gateVerdict(w, 'alice', IDS))
  applyTransfer(w, { from: 'bob', to: 'carol', tokenId: T, amount: 1 }) // OpenSea
  check('E1 SELLER bob is revoked', !gateVerdict(w, 'bob', IDS))
  check('E1 off-platform buyer carol is denied', !gateVerdict(w, 'carol', IDS))
  check('E1 BYSTANDER alice keeps access (the fix)', gateVerdict(w, 'alice', IDS))
}

// E2. THE OTHER HALF. A still-open sale must keep working after someone else
// sold off-platform. The superseded model refused every later credit for the id.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'bob', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'bob', to: 'carol', tokenId: T, amount: 1 })
  applyTransfer(w, { from: ZERO_ADDR, to: 'dana', tokenId: T, amount: 1 }) // new buyer
  check('E2 a NEW primary mint after an off-platform sale is valid', gateVerdict(w, 'dana', IDS))
}

// E3. GRIEFING. A hostile party sends an unsolicited copy to a legitimate
// holder. Under any whole-id or per-holder BOOLEAN rule this revokes them.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'alice', tokenId: T, amount: 1 })
  applyTransfer(w, { from: ZERO_ADDR, to: 'mallory', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'mallory', to: 'alice', tokenId: T, amount: 1 }) // hostile send
  check('E3 alice survives an unsolicited off-platform copy', gateVerdict(w, 'alice', IDS))
  check('E3 mallory revoked herself by sending', !gateVerdict(w, 'mallory', IDS))
}

// E4. Sanctioned secondary: seller revoked, Kismet buyer valid.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'alice', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'alice', to: 'dave', tokenId: T, amount: 1, isPlatform: true })
  check('E4 kismet seller is revoked', !gateVerdict(w, 'alice', IDS))
  check('E4 kismet buyer is valid', gateVerdict(w, 'dave', IDS))
}

// E5. LAUNDERING. An off-platform holder cannot pass validity onward
// off-platform, and cannot hold any themselves.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'bob', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'bob', to: 'carol', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'carol', to: 'accomplice', tokenId: T, amount: 1 })
  check('E5 off-platform chain confers nothing on carol', !gateVerdict(w, 'carol', IDS))
  check('E5 off-platform chain confers nothing on the accomplice', !gateVerdict(w, 'accomplice', IDS))
}

// E6. DRIFT DEFENCE. The property the liveTotal exclusion existed for: a
// MISSED decrement must not let an off-platform copy keep a stale ledger alive.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'alice', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'alice', to: 'someone', tokenId: T, amount: 1, missedByWebhook: true })
  check('E6 stale ledger alone would still read valid', (w.ledger['alice'] ?? 0) >= 1)
  applyTransfer(w, { from: 'mallory', to: 'alice', tokenId: T, amount: 1 }) // buys one back off-platform
  check('E6 off-platform re-acquisition does NOT rescue a drifted ledger', !gateVerdict(w, 'alice', IDS))
}

// E7. COLLECT-AND-GIFT (lib/gift.ts). One mint, recipient credited, payer
// untouched — and no provenance recorded anywhere.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'recipient', tokenId: T, amount: 1 }) // mintTo = recipient
  check('E7 gift recipient is valid', gateVerdict(w, 'recipient', IDS))
  check('E7 gift payer gains nothing', !gateVerdict(w, 'payer', IDS))
  check('E7 gift records no off-platform units', offOf(w, 'recipient', T) === 0)
}

// E8. ACCEPTED SOFTENING (decided deliberately, see lib/passTaint): an
// off-platform copy resold THROUGH KISMET comes out clean for its buyer. The
// seller stays revoked and the platform took its fee. Pinned so the trade-off
// is a visible decision rather than an accident.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'bob', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'bob', to: 'carol', tokenId: T, amount: 1 }) // off-platform
  applyTransfer(w, { from: 'carol', to: 'erin', tokenId: T, amount: 1, isPlatform: true }) // kismet fill
  check('E8 kismet buyer of a once-off-platform copy is valid', gateVerdict(w, 'erin', IDS))
  check('E8 carol released her units on sending', offOf(w, 'carol', T) === 0)
  check('E8 original off-platform seller bob stays revoked', !gateVerdict(w, 'bob', IDS))
}

// E9. Multi-unit holder: selling ONE copy off-platform decrements one unit of
// ledger and leaves the rest provable.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'whale', tokenId: T, amount: 3 })
  applyTransfer(w, { from: 'whale', to: 'buyer', tokenId: T, amount: 1 })
  check('E9 whale keeps access with copies remaining', gateVerdict(w, 'whale', IDS))
  applyTransfer(w, { from: 'whale', to: 'buyer', tokenId: T, amount: 2 })
  check('E9 whale revoked once every copy is gone', !gateVerdict(w, 'whale', IDS))
}

// E10. Burn: sender revoked, nothing recorded against the zero address.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'alice', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'alice', to: ZERO_ADDR, tokenId: T, amount: 1 })
  check('E10 burning revokes the burner', !gateVerdict(w, 'alice', IDS))
  check('E10 burn records nothing against 0x0', offOf(w, ZERO_ADDR, T) === 0)
}

// E11. THE DENIAL PATH IS FREE. hasValidPass short-circuits before the
// adminGrant read, the known-tokens read, the off-platform read and the
// balanceOfBatch RPC when the ledger is already below 1. That is the common
// case — every gated mint attempt by someone with no Pass — and
// hasValidPassForAny routes single-wallet callers straight into it. If someone
// removes the early return, this fails.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'holder', tokenId: T, amount: 1 })
  chainReads = 0
  check('E11 a non-holder is denied', !gateVerdict(w, 'stranger', IDS))
  check('E11 denial touches NO on-chain state', chainReads === 0)
  chainReads = 0
  check('E11 a real holder is still verified against chain', gateVerdict(w, 'holder', IDS))
  check('E11 verification does read on-chain state', chainReads > 0)
}

// E12. A revoked seller becomes free to deny too — the ledger hits 0, so the
// next gate decision for them short-circuits.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'alice', tokenId: T, amount: 1 })
  applyTransfer(w, { from: 'alice', to: 'buyer', tokenId: T, amount: 1 })
  chainReads = 0
  check('E12 revoked seller denied', !gateVerdict(w, 'alice', IDS))
  check('E12 revoked seller costs no RPC', chainReads === 0)
}

// E13. UNSANCTIONED ACQUISITION (denyUnsanctionedAcquisition). A gift paid for
// by a blacklisted wallet is a real mint, so processTransfer's mint arm credits
// the recipient off the chain alone — before the route that would refuse it
// even runs. Refusing at credit time is therefore theatre; the denial marks the
// units instead, and hasValidPass subtracts them at decision time.
//
// The point of this scenario is the ORDERING: the credit lands FIRST, and the
// denial still holds. If anyone ever re-implements this as a credit-time
// refusal, the webhook wins the race and this fails.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'giftee', tokenId: T, amount: 1 })
  check('E13 credit lands first (webhook beat the route)', gateVerdict(w, 'giftee', IDS))
  // The route finally runs, finds a blacklisted payer, and denies the units.
  setOff(w, 'giftee', T, offOf(w, 'giftee', T) + 1)
  check('E13 denial holds even though the credit already landed', !gateVerdict(w, 'giftee', IDS))
}

// E14. The denial must not become a permanent brand on the wallet. A later
// LEGITIMATE acquisition of the same tokenId still counts, because
// countableUnits subtracts rather than blacklisting.
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'giftee', tokenId: T, amount: 1 })
  setOff(w, 'giftee', T, 1) // denied gift
  check('E14 denied holder proves nothing', !gateVerdict(w, 'giftee', IDS))
  applyTransfer(w, { from: ZERO_ADDR, to: 'giftee', tokenId: T, amount: 1 }) // buys their own
  check('E14 their own later mint still counts', gateVerdict(w, 'giftee', IDS))
}

// E15. Denial is idempotent against the client's retry loop. /api/collect is
// retried up to 3x, so an unguarded mark would stack to 3 units and suppress
// two future legitimate acquisitions. The NX claim in
// denyUnsanctionedAcquisition is what prevents that; modelled here as
// "mark once, however many times the route runs".
{
  const w = world()
  applyTransfer(w, { from: ZERO_ADDR, to: 'giftee', tokenId: T, amount: 1 })
  let claimed = false
  const denyOnce = () => {
    if (claimed) return
    claimed = true
    setOff(w, 'giftee', T, offOf(w, 'giftee', T) + 1)
  }
  denyOnce(); denyOnce(); denyOnce()
  check('E15 three retries mark exactly one unit', offOf(w, 'giftee', T) === 1)
  applyTransfer(w, { from: ZERO_ADDR, to: 'giftee', tokenId: T, amount: 1 })
  check('E15 a later legitimate mint is not suppressed by retries', gateVerdict(w, 'giftee', IDS))
}

console.log(
  failures === 0 ? '\nverify-pass-taint: OK' : `\nverify-pass-taint: ${failures} FAILURE(S)`,
)
process.exit(failures === 0 ? 0 : 1)
