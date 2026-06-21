#!/usr/bin/env node
// Reads Zora-1155 `permissions(0, addr)` on a collection and reports whether
// each address holds ADMIN (bit 2). The CLI counterpart to the BaseScan reads
// that settle "who is authorized to mint into this collection" — the kind of
// chain fact that, per our 2026 investigation, must be VERIFIED ON-CHAIN and
// never inferred from comments/commit messages.
//
// Defaults to checking NEXT_PUBLIC_OPERATOR_SMART_WALLET (so the common
// "is the operator authorized here?" question is one command). Pass any extra
// addresses — e.g. the creator EOA and their per-creator smart wallet
// (resolve via GET api.inprocess.world/api/smartwallet?walletAddress=<eoa>) —
// to compare. The mint executor is the per-creator wallet, not the operator.
//
// Usage:
//   node scripts/check-collection-perms.mjs <collection> [addr ...]
//   NEXT_PUBLIC_BASE_RPC_URL=<rpc>  (optional; falls back to a public Base RPC)
import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

const isAddr = (a) => /^0x[a-fA-F0-9]{40}$/.test(a)

const [collection, ...extra] = process.argv.slice(2)
if (!collection || !isAddr(collection)) {
  console.error('usage: node scripts/check-collection-perms.mjs <collection> [addr ...]')
  process.exit(1)
}

const ADMIN_BIT = 2n
const PERMISSIONS_ABI = [
  {
    name: 'permissions',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
]

const operator = process.env.NEXT_PUBLIC_OPERATOR_SMART_WALLET
const candidates = [
  ...(operator ? [['operator', operator]] : []),
  ...extra.map((a) => ['arg', a]),
]
if (candidates.length === 0) {
  console.error('no addresses to check: set NEXT_PUBLIC_OPERATOR_SMART_WALLET or pass addresses')
  process.exit(1)
}

const client = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

const results = []
for (const [label, addr] of candidates) {
  if (!isAddr(addr)) {
    results.push({ label, addr, error: 'not a valid 0x address' })
    continue
  }
  try {
    const perms = await client.readContract({
      address: collection,
      abi: PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [0n, addr],
    })
    results.push({
      label,
      addr,
      perms: perms.toString(),
      admin: (perms & ADMIN_BIT) === ADMIN_BIT,
    })
  } catch (err) {
    results.push({ label, addr, error: err.message })
  }
}

console.log(JSON.stringify({ collection, tokenId: 0, results }, null, 2))
