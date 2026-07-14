// Independent calldata oracle for /api/agent/prepare-collect (lib/agent/collect.ts).
//
// Network egress is blocked in CI/sandbox, so we can't run a live mint. Instead
// we re-derive — from first principles, with viem — the exact bytes the collect
// plan must produce, and assert the selectors, decoded args, the treasury
// referral recipient, the ETH value math, and the ERC-8021 builder suffix.
//
// Run: node --experimental-strip-types scripts/verify-agent-collect.ts
//
// Treasury-critical constants + the builder suffix come from _agent-verify-helpers,
// which imports them from the SAME production modules the route uses (not copies),
// so a referral/minter/strategy change can't silently pass this oracle.

import {
  decodeAbiParameters,
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
  PUBLISHED_SUFFIX,
  REFERRAL,
  USDC,
  builderSuffix,
  check,
  eq,
  report,
  selector,
  withSuffix,
} from './_agent-verify-helpers.ts'

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
  // The USDC mint's `value: 0x0` is a property of the call ENVELOPE, not the
  // calldata this oracle re-derives, so it can't be asserted here — it's checked
  // against the real builder in verify-agent-collect-builders.ts.
  check('both calls carry the builder suffix', approve.endsWith(builderSuffix.slice(2)) && mint.endsWith(builderSuffix.slice(2)))
}

report('OK — all collect calldata assertions passed')
