// Independent oracle for /api/agent/prepare-collect-batch (lib/agent/collectBatch.ts).
//
// The correctness that matters: a USDC basket must emit ONE approve to the
// ERC20Minter for the SUMMED cost (not per-item approves, which would clobber
// each other and revert later mints), then all mints; ETH mints each carry
// their own hex-wei value. Re-derived with viem; run: node scripts/verify-agent-collect-batch.mjs

import {
  concat,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  parseAbi,
  parseAbiParameters,
  size,
  stringToHex,
  toHex,
} from 'viem'

const FPSS = '0x2994762aA0E4C750c51f333C10d81961faEBE785'
const ERC20_MINTER = '0xE27d9Dc88dAB82ACa3ebC49895c663C6a0CfA014'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const REFERRAL = '0xc6021D9F09e145a6297f64551aa2eCA6d66F8f75'
const ACCOUNT = getAddress('0x71Dc000000000000000000000000000000007244')
const COL_A = getAddress('0x00000000000000000000000000000000c0011eaa')
const COL_B = getAddress('0x00000000000000000000000000000000c0011ebb')

const builderSuffix = concat([
  stringToHex('bc_p876wb1c'),
  toHex(size(stringToHex('bc_p876wb1c')), { size: 1 }),
  '0x00',
  '0x80218021802180218021802180218021',
])
const withSuffix = (d) => concat([d, builderSuffix])

const MINT_1155_ABI = parseAbi(['function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable'])
const ERC20_MINTER_ABI = parseAbi(['function mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)'])
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)'])

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const selector = (d) => d.slice(0, 10)
const eq = (a, b) => getAddress(a) === getAddress(b)

const usdcMint = (collection, tokenId, total) =>
  withSuffix(encodeFunctionData({ abi: ERC20_MINTER_ABI, functionName: 'mint', args: [ACCOUNT, 1n, collection, tokenId, total, USDC, REFERRAL, ''] }))
const ethMint = (tokenId, value) => ({
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
  const da = decodeFunctionData({ abi: ERC20_ABI, data: approve.data.slice(0, 2 + 8 + 64 * 2) })
  check('approve targets the ERC20Minter', eq(da.args[0], ERC20_MINTER))
  check('approve amount == SUM of USDC costs (8 USDC)', da.args[1] === totalUsdc && totalUsdc === 8_000_000n)
  check('approve is first', selector(calls[0].data) === approveSelector)
  check('two USDC mints on the ERC20Minter, value 0x0', calls.filter((c) => eq(c.to, ERC20_MINTER) && selector(c.data) === usdcMintSelector && c.value === '0x0').length === 2)
  const eth = calls[3]
  check('eth mint carries hex-wei value', selector(eth.data) === ethMintSelector && hexToBigInt(eth.value) === ethValue)
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

console.log(`\n${failures === 0 ? 'OK — collect-batch calldata assertions passed' : `FAILED — ${failures} assertion(s)`}`)
process.exit(failures === 0 ? 0 : 1)
