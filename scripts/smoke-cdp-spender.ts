/**
 * CDP spender mainnet smoke — the LAST gate before Agent Collect goes live.
 *
 * Everything else about the autonomous-spend path is verified offline (calldata
 * oracles + the live-behavior harness), but one thing only a real run can prove:
 * that YOUR CDP project's credentials, smart account, and paymaster actually
 * submit a sponsored user operation on Base mainnet. This script proves exactly
 * that with ZERO user funds and zero contract side effects:
 *
 *   1. Resolves the deterministic owner + smart account (same names as prod).
 *   2. Checks the address against NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS if set.
 *   3. Submits ONE sponsored user op: a 0-value, empty-calldata call from the
 *      smart account to itself. No token movement, no mint, no approvals —
 *      it only exercises auth → account → paymaster sponsorship → bundler →
 *      inclusion → receipt, the exact seam every autonomous collect uses.
 *
 * Run (with production env values):
 *   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=... \
 *   CDP_PAYMASTER_URL=... \
 *   node --experimental-strip-types scripts/smoke-cdp-spender.ts
 *
 * PASS = "SMOKE PASSED" with a tx hash you can open on basescan.
 * Any throw = fix the printed stage before launch (credentials, paymaster
 * allowlist/policy, or account mismatch).
 */

const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET, CDP_PAYMASTER_URL } = process.env

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET || !CDP_WALLET_SECRET) {
  console.error('Error: set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET (production values).')
  process.exit(1)
}

const ownerName = process.env.CDP_SCOUT_OWNER_NAME || 'kismet-scout-owner'
const accountName = process.env.CDP_SCOUT_ACCOUNT_NAME || 'kismet-scout-spender'

console.log('CDP spender smoke — Base mainnet, zero-value sponsored op')
console.log(`  Owner name:    ${ownerName}`)
console.log(`  Account name:  ${accountName}`)
console.log(`  Paymaster URL: ${CDP_PAYMASTER_URL ? 'set (explicit sponsorship)' : 'UNSET — SDK will auto-derive; set it for deterministic gasless'}`)
console.log()

console.log('[1/4] Authenticating + resolving deterministic smart account…')
const { CdpClient } = await import('@coinbase/cdp-sdk')
const cdp = new CdpClient({ apiKeyId: CDP_API_KEY_ID, apiKeySecret: CDP_API_KEY_SECRET, walletSecret: CDP_WALLET_SECRET })
const owner = await cdp.evm.getOrCreateAccount({ name: ownerName })
const smartAccount = await cdp.evm.getOrCreateSmartAccount({ name: accountName, owner })
console.log(`      Smart account: ${smartAccount.address}`)

console.log('[2/4] Checking against NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS…')
const configured = process.env.NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS
if (!configured) {
  console.log('      (not set — set it to the address above before building the app)')
} else if (configured.toLowerCase() !== smartAccount.address.toLowerCase()) {
  console.error(`      MISMATCH: env has ${configured} but CDP resolves ${smartAccount.address}.`)
  console.error('      Users would grant permissions to a spender that cannot spend them. Fix before launch.')
  process.exit(1)
} else {
  console.log('      OK — matches the address users grant to.')
}

console.log('[3/4] Submitting one sponsored 0-value user op (account → itself, empty calldata)…')
let userOpHash: string
try {
  const sent = await smartAccount.sendUserOperation({
    calls: [{ to: smartAccount.address, value: 0n, data: '0x' }],
    network: 'base',
    ...(CDP_PAYMASTER_URL ? { paymasterUrl: CDP_PAYMASTER_URL } : {}),
  })
  userOpHash = sent.userOpHash
  console.log(`      Broadcast — userOpHash ${userOpHash}`)
} catch (err) {
  console.error('      FAILED before broadcast — this is the paymaster/credentials stage.')
  console.error('      Typical causes: paymaster policy blocks the call, sponsorship budget exhausted, wrong project.')
  throw err
}

console.log('[4/4] Waiting for on-chain confirmation…')
const result = await smartAccount.waitForUserOperation({
  userOpHash: userOpHash as `0x${string}`,
  waitOptions: { timeoutSeconds: 120 },
})
if (result.status !== 'complete') {
  console.error(`      User op ${userOpHash} did not complete (status: ${result.status}).`)
  process.exit(1)
}

console.log()
console.log(`SMOKE PASSED — sponsored user op landed: https://basescan.org/tx/${result.transactionHash}`)
console.log('The exact auth → paymaster → bundler seam every autonomous collect uses is live.')
console.log('Remaining launch steps: set the env vars in the deploy, build, deploy, then grant a small real budget and run once.')

export {}
