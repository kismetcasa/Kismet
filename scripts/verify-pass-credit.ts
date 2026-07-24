// Guards lib/passCredit.shouldCreditTransfer — the Pass validity credit rule.
//
// THE REGRESSION IT GUARDS: the webhook (lib/pass-validity.processTransfer)
// must credit a MINT (from == 0x0) even when no platform flag was set for the
// tx. The original `if (platform)` condition credited ONLY flagged txs, so a
// Pass mint whose client-side /api/collect never ran (a hung
// waitForTransactionReceipt or a POST dropped on tab-close — the desktop-
// browser mint path) credited no one and permanently stranded the buyer behind
// the creator gate, with no error and no trace. That shipped to production and
// stranded a real buyer. A mint must always credit; an unflagged non-mint
// transfer (OpenSea / P2P / direct Seaport) must never credit, or off-platform
// transfers would launder validity.
//
// Run: node --experimental-strip-types scripts/verify-pass-credit.ts

import { shouldCreditTransfer } from '../lib/passCredit.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

// MINT — always credits, WITH or WITHOUT a platform flag. The no-flag case is
// the exact regression: a mint the client never recorded still earns validity
// from the on-chain event alone.
check('mint, no platform flag → credit', shouldCreditTransfer({ platform: false, isMint: true }) === true)
check('mint, platform flag → credit', shouldCreditTransfer({ platform: true, isMint: true }) === true)

// PLATFORM-verified non-mint (Kismet collect / airdrop / secondary fill) credits.
check('platform-verified transfer → credit', shouldCreditTransfer({ platform: true, isMint: false }) === true)

// NEITHER — an unflagged, non-mint transfer must NOT credit. This is the
// off-platform path (OpenSea sale, P2P safeTransferFrom, direct Seaport fill);
// crediting it would launder validity onto an off-platform recipient.
check('unflagged non-mint transfer → no credit', shouldCreditTransfer({ platform: false, isMint: false }) === false)

if (failures > 0) {
  console.error(`\n${failures} pass-credit check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll pass-credit checks passed.')
