// Guards lib/giftFund — the claim-acceptance rules under the Gift Fund
// (community-backed gifts, reimbursement model).
//
// THE REGRESSIONS IT GUARDS. The claim route is UNAUTHENTICATED: anyone can
// POST any txHash, and the backer is derived from the chain. Every rule here
// is therefore the trust boundary itself:
//
//   1. THE LAUNDERING RULE. An organizer's wallet already receives ETH from
//      Seaport fills and splits distributions. The trace tier must credit
//      ONLY a direct value-call whose caller is a UserOperationEvent sender
//      of that same receipt — a Seaport-shaped trace (value arriving from a
//      conduit) must yield NOTHING, or a listing purchase becomes a fake
//      "contribution" and the progress bar becomes a lie.
//   2. THE RECEIPT SHAPE. The EOA tier accepts only tx.to == organizer.
//      Value reaching the organizer any other way must fall through to the
//      trace tier's stricter rule, never be credited from the envelope.
//   3. TWO CLOCKS. Acceptance is by TRANSFER time (inside the campaign
//      window); the CLAIM may arrive up to the grace period later. Collapse
//      them and either pre-campaign transfers become claimable or a
//      last-minute contribution is lost to POST latency.
//   4. MONOTONIC STATUS. goalWei is frozen and raisedWei only grows, so
//      'funded' can never regress — and it outranks 'expired'.
//
// Run: node --experimental-strip-types scripts/verify-gift-fund.ts

import {
  campaignStatus,
  payerForMint,
  claimWindowOpen,
  CLAIM_GRACE_MS,
  evaluateReceiptTransfer,
  evaluateTracedTransfer,
  MIN_CONTRIBUTION_WEI,
  parseWei,
  progressPercent,
  transferWithinWindow,
} from '../lib/giftFund.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const ORGANIZER = '0x1111111111111111111111111111111111111111'
const BACKER = '0x2222222222222222222222222222222222222222'
const SEAPORT = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'
const ONE_ETH = 10n ** 18n

console.log('\nevaluateReceiptTransfer — the EOA tier')

const r = evaluateReceiptTransfer({
  txFrom: BACKER,
  txTo: ORGANIZER,
  valueWei: ONE_ETH,
  organizer: ORGANIZER,
})
check('plain send to organizer is credited', r !== null && r.amountWei === ONE_ETH)
check('backer derived from tx.from, lowercased', r?.backer === BACKER)
check(
  'organizer match is case-insensitive',
  evaluateReceiptTransfer({
    txFrom: BACKER,
    txTo: ORGANIZER.toUpperCase().replace('0X', '0x'),
    valueWei: ONE_ETH,
    organizer: ORGANIZER,
  }) !== null,
)
check(
  'send to anyone else yields nothing',
  evaluateReceiptTransfer({ txFrom: BACKER, txTo: OTHER, valueWei: ONE_ETH, organizer: ORGANIZER }) ===
    null,
)
check(
  'contract-call tx (to = EntryPoint) falls through to the trace tier',
  evaluateReceiptTransfer({ txFrom: BACKER, txTo: SEAPORT, valueWei: 0n, organizer: ORGANIZER }) ===
    null,
)
check(
  'dust below the minimum is rejected',
  evaluateReceiptTransfer({
    txFrom: BACKER,
    txTo: ORGANIZER,
    valueWei: MIN_CONTRIBUTION_WEI - 1n,
    organizer: ORGANIZER,
  }) === null,
)
check(
  'exactly the minimum is accepted',
  evaluateReceiptTransfer({
    txFrom: BACKER,
    txTo: ORGANIZER,
    valueWei: MIN_CONTRIBUTION_WEI,
    organizer: ORGANIZER,
  }) !== null,
)
check(
  'missing to (contract creation) yields nothing',
  evaluateReceiptTransfer({ txFrom: BACKER, txTo: null, valueWei: ONE_ETH, organizer: ORGANIZER }) ===
    null,
)

console.log('\nevaluateTracedTransfer — the smart-wallet tier')

// The qualifying shape: the userOp sender's account pays the organizer directly.
const t = evaluateTracedTransfer({
  calls: [{ from: BACKER, to: ORGANIZER, valueWei: ONE_ETH }],
  userOpSenders: [BACKER],
  organizer: ORGANIZER,
})
check('direct call from the userOp sender is credited', t !== null && t.amountWei === ONE_ETH)
check('backer is the smart account, lowercased', t?.backer === BACKER)

// THE LAUNDERING RULE. A Seaport fill's value-call comes from the conduit,
// which is never a userOp sender — nothing is credited, whatever the value.
check(
  'SEAPORT-SHAPED TRACE YIELDS NOTHING (laundering rule)',
  evaluateTracedTransfer({
    calls: [{ from: SEAPORT, to: ORGANIZER, valueWei: ONE_ETH }],
    userOpSenders: [BACKER],
    organizer: ORGANIZER,
  }) === null,
)
check(
  'even a smart-wallet-initiated Seaport fill yields nothing (conduit is not the sender)',
  evaluateTracedTransfer({
    calls: [
      { from: BACKER, to: SEAPORT, valueWei: ONE_ETH }, // account funds the fill
      { from: SEAPORT, to: ORGANIZER, valueWei: ONE_ETH }, // conduit pays the organizer
    ],
    userOpSenders: [BACKER],
    organizer: ORGANIZER,
  }) === null,
)
check(
  'an EOA tx (no UserOperationEvent) is never credited by trace',
  evaluateTracedTransfer({
    calls: [{ from: BACKER, to: ORGANIZER, valueWei: ONE_ETH }],
    userOpSenders: [],
    organizer: ORGANIZER,
  }) === null,
)
check(
  'split sends from one sender SUM before the minimum applies',
  evaluateTracedTransfer({
    calls: [
      { from: BACKER, to: ORGANIZER, valueWei: MIN_CONTRIBUTION_WEI / 2n },
      { from: BACKER, to: ORGANIZER, valueWei: MIN_CONTRIBUTION_WEI / 2n },
    ],
    userOpSenders: [BACKER],
    organizer: ORGANIZER,
  }) !== null,
)
check(
  'value to a third party does not count toward the organizer',
  evaluateTracedTransfer({
    calls: [{ from: BACKER, to: OTHER, valueWei: ONE_ETH }],
    userOpSenders: [BACKER],
    organizer: ORGANIZER,
  }) === null,
)
{
  // Two userOp senders in one bundle: one claim, one backer — the largest.
  const multi = evaluateTracedTransfer({
    calls: [
      { from: BACKER, to: ORGANIZER, valueWei: ONE_ETH },
      { from: OTHER, to: ORGANIZER, valueWei: 2n * ONE_ETH },
    ],
    userOpSenders: [BACKER, OTHER],
    organizer: ORGANIZER,
  })
  check('multi-sender bundle credits the largest contributor', multi?.backer === OTHER)
}
check(
  'case-insensitive sender binding',
  evaluateTracedTransfer({
    calls: [{ from: BACKER.toUpperCase().replace('0X', '0x'), to: ORGANIZER, valueWei: ONE_ETH }],
    userOpSenders: [BACKER],
    organizer: ORGANIZER,
  }) !== null,
)

console.log('\ntwo clocks — transfer window vs claim window')

const openedAtMs = 1_000_000
const closesAtMs = 2_000_000
check(
  'transfer inside the window counts',
  transferWithinWindow({ blockTimestampMs: 1_500_000, openedAtMs, closesAtMs }),
)
check(
  'PRE-CAMPAIGN transfer does not count (old payments unclaimable)',
  !transferWithinWindow({ blockTimestampMs: 999_999, openedAtMs, closesAtMs }),
)
check(
  'post-close transfer does not count',
  !transferWithinWindow({ blockTimestampMs: 2_000_001, openedAtMs, closesAtMs }),
)
check(
  'boundary timestamps count (inclusive window)',
  transferWithinWindow({ blockTimestampMs: openedAtMs, openedAtMs, closesAtMs }) &&
    transferWithinWindow({ blockTimestampMs: closesAtMs, openedAtMs, closesAtMs }),
)
check(
  'claim allowed during the grace period after close',
  claimWindowOpen({ closesAtMs, nowMs: closesAtMs + CLAIM_GRACE_MS }),
)
check(
  'claim refused after the grace period',
  !claimWindowOpen({ closesAtMs, nowMs: closesAtMs + CLAIM_GRACE_MS + 1 }),
)

console.log('\ncampaignStatus — monotonic, funded outranks expired')

check(
  'open while under goal and inside window',
  campaignStatus({ raisedWei: 1n, goalWei: 10n, closesAtMs, nowMs: 1_500_000 }) === 'open',
)
check(
  'funded at goal',
  campaignStatus({ raisedWei: 10n, goalWei: 10n, closesAtMs, nowMs: 1_500_000 }) === 'funded',
)
check(
  'FUNDED OUTRANKS EXPIRED (goal reached is terminal success)',
  campaignStatus({ raisedWei: 10n, goalWei: 10n, closesAtMs, nowMs: 9_999_999 }) === 'funded',
)
check(
  'expired past window under goal',
  campaignStatus({ raisedWei: 1n, goalWei: 10n, closesAtMs, nowMs: 2_000_001 }) === 'expired',
)
check(
  'zero goal can never read funded (malformed campaign fails safe)',
  campaignStatus({ raisedWei: 5n, goalWei: 0n, closesAtMs, nowMs: 1_500_000 }) === 'open',
)

console.log('\npayerForMint — shared-bundle attribution by log order')

// The EntryPoint emits each op's UserOperationEvent AFTER that op's logs, so
// the mint's payer is the first event past the mint log — never an earlier
// op's sender, never a guess.
check(
  'sole op: its sender is the payer',
  payerForMint({ userOpEvents: [{ sender: BACKER, logIndex: 9 }], mintLogIndex: 4 }) === BACKER,
)
check(
  'shared bundle: the FIRST event after the mint wins, not the closest-overall',
  payerForMint({
    userOpEvents: [
      { sender: OTHER, logIndex: 2 }, // earlier op — its event precedes the mint
      { sender: BACKER, logIndex: 9 }, // the mint op's own event
      { sender: SEAPORT, logIndex: 15 }, // a later op
    ],
    mintLogIndex: 4,
  }) === BACKER,
)
check(
  'an event BEFORE the mint can never be the payer',
  payerForMint({ userOpEvents: [{ sender: OTHER, logIndex: 2 }], mintLogIndex: 4 }) === null,
)
check(
  'no events → null (caller refuses, never guesses)',
  payerForMint({ userOpEvents: [], mintLogIndex: 4 }) === null,
)
check(
  'payer is lowercased',
  payerForMint({
    userOpEvents: [{ sender: BACKER.toUpperCase().replace('0X', '0x'), logIndex: 9 }],
    mintLogIndex: 4,
  }) === BACKER,
)

console.log('\nparseWei / progressPercent — storage round-trip and the bar')

check("'1000' round-trips", parseWei('1000') === 1000n)
check('number form reads (Upstash dual representation)', parseWei(1000) === 1000n)
check('garbage reads 0 (under-report, never fabricate)', parseWei('abc') === 0n && parseWei(null) === 0n)
check('negative reads 0', parseWei(-5) === 0n)
check('progress caps at 100 on overshoot', progressPercent(15n, 10n) === 100)
check('progress floors correctly', progressPercent(1n, 3n) === 33)
check('zero goal reads 0%', progressPercent(5n, 0n) === 0)

console.log(failures === 0 ? '\nverify-gift-fund: OK' : `\nverify-gift-fund: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
