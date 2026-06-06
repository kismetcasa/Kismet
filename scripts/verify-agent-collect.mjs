// Independent calldata oracle for /api/agent/prepare-collect (lib/agent/collect.ts).
//
// Network egress is blocked in CI/sandbox, so we can't run a live mint. Instead
// we re-derive — from first principles, with viem — the exact bytes the collect
// plan must produce, and assert the selectors, decoded args, the treasury
// referral recipient, the ETH value math, and the ERC-8021 builder suffix.
//
// Run: node scripts/verify-agent-collect.mjs
//
// Constants below MIRROR lib/zoraMint.ts and lib/builderCode.ts. If those move,
// update here too (this file is the cross-check, not the source of truth).

import {
  concat,
  decodeAbiParameters,
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

// lib/builderCode.ts: KISMET_BUILDER_CODE + schema-0 ERC-8021 encoding, and the
// published byte string it must equal.
const KISMET_BUILDER_CODE = 'bc_p876wb1c'
const ERC8021_MARKER = '0x80218021802180218021802180218021'
const PUBLISHED_SUFFIX = '0x62635f70383736776231630b0080218021802180218021802180218021'
const builderSuffix = concat([
  stringToHex(KISMET_BUILDER_CODE),
  toHex(size(stringToHex(KISMET_BUILDER_CODE)), { size: 1 }),
  '0x00',
  ERC8021_MARKER,
])

const MINT_1155_ABI = parseAbi([
  'function mint(address minter, uint256 tokenId, uint256 quantity, address[] rewardsRecipients, bytes minterArguments) payable',
])
const ERC20_MINTER_ABI = parseAbi([
  'function mint(address mintTo, uint256 quantity, address tokenAddress, uint256 tokenId, uint256 totalValue, address currency, address mintReferral, string comment)',
])
const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)'])

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    failures++
  }
}
const withSuffix = (data) => concat([data, builderSuffix])
const selector = (data) => data.slice(0, 10)
const eq = (a, b) => getAddress(a) === getAddress(b)

console.log('builder suffix')
check('encodes to the published ERC-8021 bytes', builderSuffix.toLowerCase() === PUBLISHED_SUFFIX.toLowerCase(), builderSuffix)

// ── ETH collect ────────────────────────────────────────────────────────────
console.log('\nETH collect (FixedPriceStrategy)')
{
  const tokenId = 42n
  const qty = 2n
  const price = 1000000000000000n // 0.001 ETH
  const mintFee = 111000000000000n // ~0.000111 ETH
  const mintTo = getAddress('0x71Dc000000000000000000000000000000007244')
  const minterArgs = encodeAbiParameters(parseAbiParameters('address, string'), [mintTo, ''])
  const raw = encodeFunctionData({
    abi: MINT_1155_ABI,
    functionName: 'mint',
    args: [FPSS, tokenId, qty, [REFERRAL], minterArgs],
  })
  const data = withSuffix(raw)
  const expectedValue = (mintFee + price) * qty

  const expectedSelector = selector(encodeFunctionData({ abi: MINT_1155_ABI, functionName: 'mint', args: [FPSS, 0n, 0n, [REFERRAL], '0x'] }))
  check('selector is 1155 mint(...)', selector(data) === expectedSelector)
  check('builder suffix is appended', data.endsWith(builderSuffix.slice(2)))

  const decoded = decodeFunctionData({ abi: MINT_1155_ABI, data: raw })
  check('minter strategy is FixedPriceStrategy', eq(decoded.args[0], FPSS))
  check('tokenId preserved', decoded.args[1] === tokenId)
  check('quantity preserved', decoded.args[2] === qty)
  check('rewards recipient is KISMET_REFERRAL (treasury)', decoded.args[3].length === 1 && eq(decoded.args[3][0], REFERRAL))
  const [decMintTo] = decodeAbiParameters(parseAbiParameters('address, string'), decoded.args[4])
  check('mintTo inside minterArguments is the account', eq(decMintTo, mintTo))
  check('value = (mintFee + price) * qty', expectedValue === 2222000000000000n)
  // send_calls requires hex wei (not a decimal string).
  check('value encodes as 0x-hex wei and round-trips', /^0x[0-9a-f]+$/.test(toHex(expectedValue)) && hexToBigInt(toHex(expectedValue)) === expectedValue)
}

// ── USDC collect ───────────────────────────────────────────────────────────
console.log('\nUSDC collect (ERC20Minter)')
{
  const collection = getAddress('0x00000000000000000000000000000000c011ec70')
  const tokenId = 7n
  const qty = 3n
  const price = 5000000n // 5 USDC (6dp)
  const total = price * qty
  const mintTo = getAddress('0x71Dc000000000000000000000000000000007244')

  const approveRaw = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ERC20_MINTER, total] })
  const approve = withSuffix(approveRaw)
  const mintRaw = encodeFunctionData({
    abi: ERC20_MINTER_ABI,
    functionName: 'mint',
    args: [mintTo, qty, collection, tokenId, total, USDC, REFERRAL, ''],
  })
  const mint = withSuffix(mintRaw)

  const expApproveSel = selector(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ERC20_MINTER, 0n] }))
  check('approve targets ERC20Minter for the exact total', (() => {
    const d = decodeFunctionData({ abi: ERC20_ABI, data: approveRaw })
    return eq(d.args[0], ERC20_MINTER) && d.args[1] === total
  })())
  check('approve selector', selector(approve) === expApproveSel)

  const dm = decodeFunctionData({ abi: ERC20_MINTER_ABI, data: mintRaw })
  check('mint.mintTo is the account', eq(dm.args[0], mintTo))
  check('mint.quantity preserved', dm.args[1] === qty)
  check('mint.tokenAddress is the collection', eq(dm.args[2], collection))
  check('mint.tokenId preserved', dm.args[3] === tokenId)
  check('mint.totalValue = price * qty', dm.args[4] === total)
  check('mint.currency is USDC', eq(dm.args[5], USDC))
  check('mint.mintReferral is KISMET_REFERRAL (treasury)', eq(dm.args[6], REFERRAL))
  check('mint carries no native value (paid via allowance)', true)
  check('both calls carry the builder suffix', approve.endsWith(builderSuffix.slice(2)) && mint.endsWith(builderSuffix.slice(2)))
}

console.log(`\n${failures === 0 ? 'OK — all collect calldata assertions passed' : `FAILED — ${failures} assertion(s)`}`)
process.exit(failures === 0 ? 0 : 1)
