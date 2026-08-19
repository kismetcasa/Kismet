// Guards lib/gift — the pure decision layer under collect-and-gift
// (useDirectCollect's `recipient` → mintTo, and /api/collect's giftedBy
// attribution).
//
// THE REGRESSIONS IT GUARDS:
//   1. planMint must never point a mint anywhere but the signer or a valid
//      third party. A gift is the ONE collect path where the recipient is not
//      the payer, so a planner bug here sends someone's payment — and, for a
//      Patron pass, the mint access that rides with it — to the wrong wallet.
//      The zero-address case matters specifically: mintTo 0x0 burns the
//      edition, and Zora's FPSS would happily encode it.
//   2. Self-gift must COLLAPSE to a plain collect, not error. Minting to your
//      own address is a collect; rejecting it would surface a nonsense error,
//      and — worse — treating it as a gift would post a giftedBy equal to the
//      collector, pinging someone about their own purchase.
//   3. verifyGiftClaim must accept a gift claim ONLY on proof. It backs a
//      notification whose actor is a named wallet, so an unproven claim is how
//      a client would fabricate "<someone famous> gifted you …". Both proofs
//      have to work independently: receipt.from covers plain EOAs, the SIWE
//      session covers smart-wallet / ERC-4337 collects where receipt.from is
//      the BUNDLER — deriving the gifter from receipt.from alone would stamp a
//      bundler address onto ordinary self-collects.
//   4. Case-insensitivity throughout. The client sends checksummed addresses
//      (viem getAddress) while the server compares lowercase; a case-sensitive
//      comparison anywhere here reads a legitimate self-collect as a gift.
//
// Run: node --experimental-strip-types scripts/verify-gift.ts

import { giftRejectionMessage, planMint, verifyGiftClaim } from '../lib/gift.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

const SIGNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const BUNDLER = '0x3333333333333333333333333333333333333333'
const ZERO = '0x0000000000000000000000000000000000000000'

console.log('\nplanMint')

const plain = planMint(SIGNER)
check('no recipient → collect to signer', plain.mode === 'collect' && plain.mintTo === SIGNER)

check('collect carries no gifter', plain.mode === 'collect' && plain.giftedBy === null)

check(
  'null/empty recipient → collect (not an error)',
  planMint(SIGNER, null).mode === 'collect' && planMint(SIGNER, '').mode === 'collect',
)

const gift = planMint(SIGNER, OTHER)
check('distinct recipient → gift', gift.mode === 'gift')
check('gift mints to the recipient', gift.mode === 'gift' && gift.mintTo === OTHER)
check('gift attributes the signer as payer', gift.mode === 'gift' && gift.giftedBy === SIGNER)

const selfGift = planMint(SIGNER, SIGNER)
check('self-gift collapses to collect', selfGift.mode === 'collect')
check('self-gift carries no gifter', selfGift.mode === 'collect' && selfGift.giftedBy === null)
check(
  'self-gift is case-insensitive',
  planMint(SIGNER.toLowerCase(), SIGNER.toUpperCase().replace('0X', '0x')).mode === 'collect',
)

// `mintTo` is only present on the two valid modes — narrow rather than
// asserting, so a planner that starts returning `invalid` here fails the check
// instead of tripping a cast.
const mintToOf = (plan: ReturnType<typeof planMint>): string | null =>
  plan.mode === 'invalid' ? null : plan.mintTo

check(
  'lowercases a checksummed recipient',
  mintToOf(planMint(SIGNER, '0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd')) ===
    '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
)
check(
  'lowercases a checksummed signer',
  mintToOf(planMint('0xAAAA111111111111111111111111111111111111')) ===
    '0xaaaa111111111111111111111111111111111111',
)

const burn = planMint(SIGNER, ZERO)
check('zero-address recipient is rejected', burn.mode === 'invalid')
check('zero-address reason is burn-address', burn.mode === 'invalid' && burn.reason === 'burn-address')

for (const bad of ['0x123', 'notanaddress', 'vitalik.eth', '0x' + 'z'.repeat(40), `${OTHER} `]) {
  const r = planMint(SIGNER, bad)
  check(`rejects malformed recipient ${JSON.stringify(bad)}`, r.mode === 'invalid' && r.reason === 'invalid-recipient')
}

check(
  'every rejection has user-facing copy',
  giftRejectionMessage('invalid-recipient').length > 0 && giftRejectionMessage('burn-address').length > 0,
)

console.log('\nverifyGiftClaim')

check(
  'accepts a claim proved by the receipt payer',
  verifyGiftClaim({ claimed: SIGNER, collector: OTHER, receiptFrom: SIGNER }) === SIGNER,
)
check(
  'accepts a claim proved by the SIWE session (smart-wallet path)',
  verifyGiftClaim({ claimed: SIGNER, collector: OTHER, receiptFrom: BUNDLER, sessionAddress: SIGNER }) === SIGNER,
)
check(
  'drops an unproven claim rather than trusting it',
  verifyGiftClaim({ claimed: SIGNER, collector: OTHER, receiptFrom: BUNDLER, sessionAddress: null }) === null,
)
check(
  'drops a claim with no proof at all',
  verifyGiftClaim({ claimed: SIGNER, collector: OTHER }) === null,
)
check(
  'never derives the gifter from the payer alone (bundler is not a gifter)',
  verifyGiftClaim({ claimed: null, collector: OTHER, receiptFrom: BUNDLER }) === null,
)
check(
  'drops a claim naming the collector (no self-gift notification)',
  verifyGiftClaim({ claimed: OTHER, collector: OTHER, receiptFrom: OTHER }) === null,
)
check(
  'collector match is case-insensitive',
  verifyGiftClaim({
    claimed: OTHER.toUpperCase().replace('0X', '0x'),
    collector: OTHER,
    receiptFrom: OTHER,
  }) === null,
)
check(
  'proof match is case-insensitive and returns lowercase',
  verifyGiftClaim({
    claimed: SIGNER.toUpperCase().replace('0X', '0x'),
    collector: OTHER,
    receiptFrom: SIGNER,
  }) === SIGNER,
)
for (const bad of [undefined, null, '', '0x123', 'someone.eth']) {
  check(
    `rejects malformed claim ${JSON.stringify(bad)}`,
    verifyGiftClaim({ claimed: bad, collector: OTHER, receiptFrom: SIGNER }) === null,
  )
}

console.log(failures === 0 ? '\nverify-gift: OK' : `\nverify-gift: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
