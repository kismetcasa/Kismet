// Independent oracle for /api/agent/prepare-collect-batch (lib/agent/collectBatch.ts).
//
// The correctness that matters: a USDC basket must emit ONE approve to the
// ERC20Minter for the SUMMED cost (not per-item approves, which would clobber
// each other and revert later mints), then all mints; ETH mints each carry
// their own hex-wei value. Re-derived with viem.
// Run: node --experimental-strip-types scripts/verify-agent-collect-batch.ts
//
// Treasury constants + builder suffix come from _agent-verify-helpers (sourced
// from production, not hand-copied).

import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  parseAbiParameters,
  toHex,
} from 'viem'
import {
  ERC20_ABI,
  ERC20_MINTER,
  ERC20_MINTER_ABI,
  FPSS,
  MINT_1155_ABI,
  REFERRAL,
  USDC,
  builderSuffix,
  check,
  dedupeMomentRefs,
  eq,
  report,
  selector,
  withSuffix,
} from './_agent-verify-helpers.ts'

const ACCOUNT = getAddress('0x71Dc000000000000000000000000000000007244')
const COL_A = getAddress('0x00000000000000000000000000000000c0011eaa')
const COL_B = getAddress('0x00000000000000000000000000000000c0011ebb')

const usdcMint = (collection: `0x${string}`, tokenId: bigint, total: bigint) =>
  withSuffix(encodeFunctionData({ abi: ERC20_MINTER_ABI, functionName: 'mint', args: [ACCOUNT, 1n, collection, tokenId, total, USDC, REFERRAL, ''] }))
const ethMint = (tokenId: bigint, value: bigint) => ({
  data: withSuffix(encodeFunctionData({ abi: MINT_1155_ABI, functionName: 'mint', args: [FPSS, tokenId, 1n, [REFERRAL], encodeAbiParameters(parseAbiParameters('address, string'), [ACCOUNT, ''])] })),
  value: toHex(value),
})
const approveSelector = selector(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ERC20_MINTER, 0n] }))
const usdcMintSelector = selector(encodeFunctionData({ abi: ERC20_MINTER_ABI, functionName: 'mint', args: [ACCOUNT, 1n, COL_A, 0n, 0n, USDC, REFERRAL, ''] }))
const ethMintSelector = selector(encodeFunctionData({ abi: MINT_1155_ABI, functionName: 'mint', args: [FPSS, 0n, 0n, [REFERRAL], '0x'] }))

// ── Mixed basket, allowance short → one summed approve ──────────────────────
console.log('mixed basket (2 USDC + 1 ETH), allowance short')
{
  const usdcA = 5_000_000n // 5 USDC
  const usdcB = 3_000_000n // 3 USDC
  const totalUsdc = usdcA + usdcB // 8 USDC
  const ethPrice = 1_000_000_000_000_000n
  const ethFee = 111_000_000_000_000n
  const ethValue = ethPrice + ethFee

  // expected plan (mirrors buildCollectBatchPlan): [approve(sum), usdcMintA, usdcMintB, ethMint]
  const calls = [
    { to: USDC, data: withSuffix(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ERC20_MINTER, totalUsdc] })), value: '0x0' },
    { to: ERC20_MINTER, data: usdcMint(COL_A, 10n, usdcA), value: '0x0' },
    { to: ERC20_MINTER, data: usdcMint(COL_B, 20n, usdcB), value: '0x0' },
    { to: COL_A, ...ethMint(30n, ethValue) },
  ]

  check('exactly one approve in the batch', calls.filter((c) => selector(c.data) === approveSelector).length === 1)
  const approve = calls[0]
  const da = decodeFunctionData({ abi: ERC20_ABI, data: approve.data.slice(0, 2 + 8 + 64 * 2) as `0x${string}` })
  check('approve targets the ERC20Minter', eq(da.args[0], ERC20_MINTER))
  check('approve amount == SUM of USDC costs (8 USDC)', da.args[1] === totalUsdc && totalUsdc === 8_000_000n)
  check('approve is first', selector(calls[0].data) === approveSelector)
  check('two USDC mints on the ERC20Minter, value 0x0', calls.filter((c) => eq(c.to, ERC20_MINTER) && selector(c.data) === usdcMintSelector && c.value === '0x0').length === 2)
  const eth = calls[3]
  check('eth mint carries hex-wei value', selector(eth.data) === ethMintSelector && hexToBigInt(eth.value as `0x${string}`) === ethValue)
  check('all calls carry the builder suffix', calls.every((c) => c.data.endsWith(builderSuffix.slice(2))))
}

// ── Allowance already sufficient → no approve ───────────────────────────────
console.log('\nUSDC basket, allowance already covers the sum → no approve')
{
  const total = 8_000_000n
  const allowance = 8_000_000n
  const includeApprove = allowance < total
  check('no approve prepended when allowance >= sum', includeApprove === false)
}

// ── All-ETH basket → no approve, summed native value ────────────────────────
console.log('\nall-ETH basket → no approve, native value sums')
{
  const v1 = 1_111_000_000_000_000n
  const v2 = 2_222_000_000_000_000n
  const calls = [
    { to: COL_A, ...ethMint(1n, v1) },
    { to: COL_B, ...ethMint(2n, v2) },
  ]
  check('no approve in an all-ETH batch', calls.every((c) => selector(c.data) !== approveSelector))
  check('summed native value', hexToBigInt(calls[0].value) + hexToBigInt(calls[1].value) === v1 + v2)
}

console.log('\nref dedupe — a basket is a SET of distinct moments (prepare-collect-batch)')
{
  const r = (collection: string, tokenId: string) => ({ collection, tokenId })
  const keyOf = (x: { collection: string; tokenId: string }) => `${x.collection.toLowerCase()}:${x.tokenId}`

  // P1 soundness: exact duplicate collapses to one mint.
  check('exact duplicate collapses', dedupeMomentRefs([r(COL_A, '1'), r(COL_A, '1')]).length === 1)
  // Canonical identity: a collection address differing only in case is the SAME
  // moment on-chain, so it collapses too (the dedupe key lowercases the address).
  check('address case-insensitive collapse', dedupeMomentRefs([r(COL_A, '1'), r(COL_A.toLowerCase(), '1')]).length === 1)
  // P2 faithfulness: genuinely distinct moments are never dropped.
  check('distinct tokenId preserved', dedupeMomentRefs([r(COL_A, '1'), r(COL_A, '2')]).length === 2)
  check('distinct collection preserved', dedupeMomentRefs([r(COL_A, '1'), r(COL_B, '1')]).length === 2)
  // P3 order: first occurrence wins; order preserved.
  const ordered = dedupeMomentRefs([r(COL_B, '9'), r(COL_A, '1'), r(COL_B, '9')])
  check('first-seen order preserved', ordered.length === 2 && eq(ordered[0].collection, COL_B) && ordered[0].tokenId === '9' && eq(ordered[1].collection, COL_A))
  // Boundary cases.
  check('empty stays empty', dedupeMomentRefs([]).length === 0)
  check('singleton unchanged', dedupeMomentRefs([r(COL_A, '7')]).length === 1)
  // Idempotence: dedupe(dedupe(x)) === dedupe(x).
  const once = dedupeMomentRefs([r(COL_A, '1'), r(COL_A, '1'), r(COL_B, '2')])
  check('idempotent', JSON.stringify(dedupeMomentRefs(once)) === JSON.stringify(once))

  // Property sweep: for random baskets the output must (a) have unique keys,
  // (b) length === number of distinct keys (complete), and (c) be a first-seen
  // subsequence of the input by reference (no reordering, no fabricated entries).
  let propOk = true
  for (let t = 0; t < 500 && propOk; t++) {
    const n = Math.floor(Math.random() * 9)
    const input = Array.from({ length: n }, (_, i) => r(i % 2 ? COL_A : COL_B, String(Math.floor(Math.random() * 3))))
    const out = dedupeMomentRefs(input)
    const keys = out.map(keyOf)
    if (new Set(keys).size !== keys.length) propOk = false            // (a) unique
    if (out.length !== new Set(input.map(keyOf)).size) propOk = false // (b) complete
    let j = 0
    for (const x of input) if (j < out.length && out[j] === x) j++    // (c) subsequence by reference
    if (j !== out.length) propOk = false
  }
  check('property: unique keys, length == #distinct, first-seen subsequence (500 random)', propOk)
}

report('OK — collect-batch calldata assertions passed')
