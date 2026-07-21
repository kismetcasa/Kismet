// Verifies wallet-rejection classification against the exact error strings
// production wallets emit, so a regex edit can't silently reopen the
// "own cancel toasts as internal error" misread (2026-07-20 incident):
// WalletConnect cancels arrive with a non-4001 code and viem's
// "An internal error was received." wrapper, so the message-level match is
// the only thing standing between a cancel and a scary failure toast.
//
// Run: node --experimental-strip-types scripts/verify-wallet-rejection.ts

import { REJECTION_REGEX } from '../lib/walletRejection.ts'

let failures = 0
const check = (name: string, cond: boolean): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}`)
    failures++
  }
}

// ── must classify as a user rejection ──
const rejections = [
  // Extension wallets (EIP-1193 4001 phrasing) — the Mac Chrome production string.
  'User rejected the request.\n\nDetails: User denied message signature\nVersion: viem@2.55.2',
  // WalletConnect relay cancel (code -32603) — the iPhone production string.
  'An internal error was received.\n\nDetails: Operation cancelled by the user.\nVersion: viem@2.55.2',
  'Operation canceled by the user.', // US single-l spelling
  'Signature cancelled by the user',
  'user canceled',
]
for (const msg of rejections) {
  check(`rejection: ${JSON.stringify(msg.slice(0, 58))}`, REJECTION_REGEX.test(msg))
}

// ── must NOT classify — real failures have to keep surfacing loudly ──
const nonRejections = [
  'An internal error was received.', // bare internal error, no cancel detail
  'execution reverted: SaleEnded',
  'Platform is temporarily paused',
  'Could not fetch sign-in nonce (HTTP 503)',
  'Transaction failed',
]
for (const msg of nonRejections) {
  check(`non-rejection: ${JSON.stringify(msg)}`, !REJECTION_REGEX.test(msg))
}

console.log(failures === 0 ? '\nAll wallet-rejection checks passed.' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
