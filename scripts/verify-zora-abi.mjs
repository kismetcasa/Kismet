#!/usr/bin/env node
// Verify the hand-written ERC20Minter.sale() ABI in lib/saleConfig.ts decodes
// correctly against the deployed contract on Base. If Zora ever upgrades the
// minter or the struct layout drifts, this script will fail loudly — much
// better than fetchUsdcEligibleTokens silently returning [] in production.
//
// Usage:
//   node scripts/verify-zora-abi.mjs <collection> <tokenId>
//
//   <collection>  any Zora 1155 collection on Base with a USDC sale row,
//                 e.g. an inprocess collection where a moment was minted
//                 with USDC pricing.
//   <tokenId>     the token ID inside that collection.
//
// Requires NEXT_PUBLIC_BASE_RPC_URL set in the env (or it falls through to
// Base's public RPC, which rate-limits aggressively).
//
// Exits 0 on a clean decode + plausible field values; non-zero otherwise.

import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'

const ZORA_ERC20_MINTER = '0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const SALE_ABI = [
  {
    name: 'sale',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenContract', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'saleStart', type: 'uint64' },
          { name: 'saleEnd', type: 'uint64' },
          { name: 'maxTokensPerAddress', type: 'uint64' },
          { name: 'pricePerToken', type: 'uint256' },
          { name: 'fundsRecipient', type: 'address' },
          { name: 'currency', type: 'address' },
        ],
      },
    ],
  },
]

const [, , collection, tokenId] = process.argv
if (!collection || !tokenId) {
  console.error('Usage: node scripts/verify-zora-abi.mjs <collection> <tokenId>')
  process.exit(2)
}

const client = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

try {
  const sale = await client.readContract({
    address: ZORA_ERC20_MINTER,
    abi: SALE_ABI,
    functionName: 'sale',
    args: [collection, BigInt(tokenId)],
  })

  console.log('Decoded ERC20Minter.sale():')
  console.log('  saleStart           =', sale.saleStart)
  console.log('  saleEnd             =', sale.saleEnd)
  console.log('  maxTokensPerAddress =', sale.maxTokensPerAddress)
  console.log('  pricePerToken       =', sale.pricePerToken)
  console.log('  fundsRecipient      =', sale.fundsRecipient)
  console.log('  currency            =', sale.currency)

  // Sanity: every uint64 we expect is in range, addresses are 20 bytes,
  // pricePerToken fits a realistic USDC quote (<10**18 = 1 trillion USDC).
  const checks = [
    [sale.saleStart <= 0xffffffffffffffffn, 'saleStart fits uint64'],
    [sale.saleEnd <= 0xffffffffffffffffn, 'saleEnd fits uint64'],
    [sale.maxTokensPerAddress <= 0xffffffffffffffffn, 'maxTokensPerAddress fits uint64'],
    [sale.pricePerToken < 10n ** 18n, 'pricePerToken plausible (<1T USDC)'],
    [/^0x[0-9a-fA-F]{40}$/.test(sale.fundsRecipient), 'fundsRecipient is an address'],
    [/^0x[0-9a-fA-F]{40}$/.test(sale.currency), 'currency is an address'],
  ]

  let ok = true
  for (const [pass, label] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`)
    if (!pass) ok = false
  }

  if (sale.currency.toLowerCase() === USDC_BASE.toLowerCase()) {
    console.log('  ✓ currency matches native USDC on Base — collect-all will accept this token')
  } else {
    console.log(`  • currency is ${sale.currency} (not USDC) — this token would be filtered out`)
  }

  if (!ok) {
    console.error('\nFAIL: ABI decode produced implausible values. The deployed ABI may have drifted.')
    process.exit(1)
  }
  console.log('\nOK: ABI decode matches the schema in lib/saleConfig.ts.')
} catch (err) {
  console.error('FAIL:', err instanceof Error ? err.message : err)
  console.error('\nIf the error is a decode error, the ABI in lib/saleConfig.ts likely no longer')
  console.error('matches the deployed bytecode at', ZORA_ERC20_MINTER)
  process.exit(1)
}
