// Guards lib/smartWalletShape.parseSmartWalletAddress — the inprocess
// GET /smartwallet response-shape parser.
//
// THE REGRESSION IT GUARDS: this lookup resolves the per-creator smart wallet
// that holds ADMIN and executes /moment/create. Narrowing the parser back to
// `.address`-only silently turns the non-canonical shapes inprocess actually
// returns (smartWallet / smart_wallet / smartAccount / raw string) into "no
// address" → { notFound } → a doomed mint that reverts at gas estimation. That
// exact regression recurred repeatedly (smart-wallet resolution = 30 commits;
// "param-resilient parser", "callers broken by discriminated return"). Pin
// every accepted shape so a future narrowing fails the build.
//
// SCOPE (honest): this guards OUR parser only. It does NOT — and cannot —
// catch inprocess CHANGING their API (renamed param, new wrapper shape, auth).
// That live-contract drift is caught separately by the boot drift-detector
// (lib/healthcheck's skipCache probe hits the real endpoint and alarms on 5xx).
//
// Run: node --experimental-strip-types scripts/verify-smartwallet.ts

import { parseSmartWalletAddress } from '../lib/smartWalletShape.ts'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}

const ADDR = '0xabcdef0123456789abcdef0123456789abcdef01'
const ADDR_UPPER = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01'

// Every shape inprocess has actually returned must resolve.
check('shape { address }', parseSmartWalletAddress({ address: ADDR }) === ADDR)
check('shape { smartWallet }', parseSmartWalletAddress({ smartWallet: ADDR }) === ADDR)
check('shape { smart_wallet }', parseSmartWalletAddress({ smart_wallet: ADDR }) === ADDR)
check('shape { smartAccount }', parseSmartWalletAddress({ smartAccount: ADDR }) === ADDR)
check('shape raw string', parseSmartWalletAddress(ADDR) === ADDR)

// inprocess returns non-checksummed/mixed-case; downstream keys on lowercase.
check('mixed/upper case is lowercased', parseSmartWalletAddress(ADDR_UPPER) === ADDR)

// Precedence: a documented field wins over a fallback one.
check('address wins over smartWallet', parseSmartWalletAddress({ address: ADDR, smartWallet: ADDR_UPPER }) === ADDR)

// Non-addresses / empties → null (the caller maps null to notFound).
check('empty object → null', parseSmartWalletAddress({}) === null)
check('non-address string → null', parseSmartWalletAddress('not-an-address') === null)
check('wrong-length hex → null', parseSmartWalletAddress('0x1234') === null)
check('null → null', parseSmartWalletAddress(null) === null)
check('number → null', parseSmartWalletAddress(42) === null)
check('address field carrying garbage → null', parseSmartWalletAddress({ address: 'nope' }) === null)

if (failures > 0) {
  console.error(`\n${failures} smart-wallet shape check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll smart-wallet shape checks passed.')
