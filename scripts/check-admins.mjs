#!/usr/bin/env node
// Classifies a list of addresses on Base as contract vs EOA. Useful for
// diagnosing entries in inprocess's `momentAdmins[]` that link to empty
// profile pages.
//
// Usage: node scripts/check-admins.mjs 0x... [0x... ...]
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

const addresses = process.argv.slice(2)
if (addresses.length === 0) {
  console.error('usage: node scripts/check-admins.mjs <addr> [<addr> ...]')
  process.exit(1)
}

const client = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

const results = []
for (const addr of addresses) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    results.push({ addr, error: 'not a valid 0x address' })
    continue
  }
  try {
    const code = await client.getCode({ address: addr })
    const isContract = !!code && code !== '0x' && code.length > 2
    results.push({ addr, kind: isContract ? 'contract' : 'eoa', codeLen: code?.length ?? 0 })
  } catch (err) {
    results.push({ addr, error: err.message })
  }
}

console.log(JSON.stringify(results, null, 2))
