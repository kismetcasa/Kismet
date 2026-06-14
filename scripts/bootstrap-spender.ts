/**
 * Bootstrap the Agent Collect spender address.
 *
 * Calls getOrCreateSmartAccount with the configured CDP creds and prints the
 * address to use as NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS. Run this ONCE before
 * the first production deploy, then paste the address into your env vars.
 *
 * The address is STABLE as long as the CDP project + account names stay the same.
 *
 * Usage:
 *   CDP_API_KEY_ID=... CDP_API_KEY_SECRET=... CDP_WALLET_SECRET=... \
 *   node --experimental-strip-types scripts/bootstrap-spender.ts
 *
 * Optional overrides (must match production values):
 *   CDP_SCOUT_OWNER_NAME=kismet-scout-owner
 *   CDP_SCOUT_ACCOUNT_NAME=kismet-scout-spender
 */

const { CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET } = process.env

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET || !CDP_WALLET_SECRET) {
  console.error('Error: set CDP_API_KEY_ID, CDP_API_KEY_SECRET, and CDP_WALLET_SECRET before running.')
  process.exit(1)
}

const ownerName = process.env.CDP_SCOUT_OWNER_NAME || 'kismet-scout-owner'
const accountName = process.env.CDP_SCOUT_ACCOUNT_NAME || 'kismet-scout-spender'

console.log(`Resolving CDP smart account…`)
console.log(`  Owner name:   ${ownerName}`)
console.log(`  Account name: ${accountName}`)
console.log()

const { CdpClient } = await import('@coinbase/cdp-sdk')
const cdp = new CdpClient({ apiKeyId: CDP_API_KEY_ID, apiKeySecret: CDP_API_KEY_SECRET, walletSecret: CDP_WALLET_SECRET })

const owner = await cdp.evm.getOrCreateAccount({ name: ownerName })
const smartAccount = await cdp.evm.getOrCreateSmartAccount({ name: accountName, owner })

console.log(`Owner EOA address:    ${owner.address}`)
console.log(`Smart account address: ${smartAccount.address}`)
console.log()
console.log(`Add to your environment:`)
console.log(`NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS=${smartAccount.address}`)
console.log()
console.log(`Reminder: NEXT_PUBLIC_ vars are inlined at Next.js build time.`)
console.log(`Set this before your first production build, then redeploy if you change it.`)

export {}
