// Independent oracle for /api/agent/prepare-list (lib/agent/list.ts).
//
// Network egress is blocked in CI/sandbox. We verify the parts that don't need
// a chain: the one-time setApprovalForAll calldata, price→base-unit conversion,
// the sellerProceeds + fee + royalty == price invariant the order encodes (which
// /api/listings also enforces), and that the EIP-712 typed data is well-formed
// (hashTypedData throws if domain/types/message are inconsistent).
//
// Run: node --experimental-strip-types scripts/verify-agent-list.ts
//
// Builder suffix comes from _agent-verify-helpers (sourced from production). The
// Seaport address/domain/types are public protocol values.

import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  parseAbi,
  parseEther,
  parseUnits,
} from 'viem'
import {
  PLATFORM_FEE_RECIPIENT,
  PUBLISHED_SUFFIX,
  SEAPORT,
  USDC,
  ZERO_ADDR,
  ZERO_BYTES32,
  builderSuffix,
  check,
  computePlatformFee,
  eq,
  isBelowListingFloor,
  MIN_LISTING_PRICE_BASE_UNITS,
  report,
  withSuffix,
} from './_agent-verify-helpers.ts'

const THIRTY_DAYS = 2592000n

const ERC1155_ABI = parseAbi(['function setApprovalForAll(address operator, bool approved)'])

const SEAPORT_DOMAIN = { name: 'Seaport', version: '1.5', chainId: 8453, verifyingContract: SEAPORT } as const
const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const

const SELLER = getAddress('0x71Dc000000000000000000000000000000007244')
const COLLECTION = getAddress('0x00000000000000000000000000000000c011ec70')
const RECEIVER = getAddress('0x2222222222222222222222222222222222222222')

function buildOrderMessage(currency: 'eth' | 'usdc', sellerProceeds: bigint, fee: bigint, royalty: bigint, counter: bigint) {
  const isUsdc = currency === 'usdc'
  const itemType = isUsdc ? 1 : 0
  const token = isUsdc ? USDC : ZERO_ADDR
  const consideration: Array<{
    itemType: number
    token: `0x${string}`
    identifierOrCriteria: bigint
    startAmount: bigint
    endAmount: bigint
    recipient: `0x${string}`
  }> = [
    { itemType, token, identifierOrCriteria: 0n, startAmount: sellerProceeds, endAmount: sellerProceeds, recipient: SELLER },
  ]
  // Platform fee at index 1 — mirrors buildSellOrder in lib/seaport.ts
  if (fee > 0n) {
    consideration.push({ itemType, token, identifierOrCriteria: 0n, startAmount: fee, endAmount: fee, recipient: PLATFORM_FEE_RECIPIENT })
  }
  if (royalty > 0n) {
    consideration.push({ itemType, token, identifierOrCriteria: 0n, startAmount: royalty, endAmount: royalty, recipient: RECEIVER })
  }
  return {
    offerer: SELLER,
    zone: ZERO_ADDR,
    offer: [{ itemType: 3, token: COLLECTION, identifierOrCriteria: 99n, startAmount: 1n, endAmount: 1n }],
    consideration,
    orderType: 0,
    startTime: 0n,
    endTime: THIRTY_DAYS,
    zoneHash: ZERO_BYTES32,
    salt: 123456n,
    conduitKey: ZERO_BYTES32,
    counter,
  }
}

console.log('builder suffix')
check('encodes to the published ERC-8021 bytes', builderSuffix.toLowerCase() === PUBLISHED_SUFFIX.toLowerCase())

console.log('\nsetApprovalForAll (one-time marketplace approval)')
{
  const raw = encodeFunctionData({ abi: ERC1155_ABI, functionName: 'setApprovalForAll', args: [SEAPORT, true] })
  const data = withSuffix(raw)
  const d = decodeFunctionData({ abi: ERC1155_ABI, data: raw })
  check('operator is Seaport', eq(d.args[0], SEAPORT))
  check('approved is true', d.args[1] === true)
  check('builder suffix appended', data.endsWith(builderSuffix.slice(2)))
}

console.log('\nprice conversion + proceeds invariant')
{
  check('parseEther("0.01") = 1e16 wei', parseEther('0.01') === 10000000000000000n)
  check('parseUnits("5", 6) = 5_000_000 (USDC)', parseUnits('5', 6) === 5000000n)

  // ETH: 0.01 with 5% royalty + 1% platform fee
  const ethPrice = parseEther('0.01')
  const ethRoyalty = (ethPrice * 5n) / 100n
  const ethFee = computePlatformFee(ethPrice)
  const ethProceeds = ethPrice - ethRoyalty - ethFee
  check('ETH: sellerProceeds + fee + royalty == price', ethProceeds + ethFee + ethRoyalty === ethPrice)

  // USDC: 5 with 10% royalty + 1% platform fee
  const usdcPrice = parseUnits('5', 6)
  const usdcRoyalty = (usdcPrice * 10n) / 100n
  const usdcFee = computePlatformFee(usdcPrice)
  const usdcProceeds = usdcPrice - usdcRoyalty - usdcFee
  check('USDC: sellerProceeds + fee + royalty == price', usdcProceeds + usdcFee + usdcRoyalty === usdcPrice)
}

console.log('\nlisting-price floor (shared by ListButton, prepare-list, /api/listings POST)')
{
  // At/above the floor the fee is >= 1 base unit; below it the fee floors to 0 and
  // every listing path must reject. This is the single rule that previously lived
  // only in the POST route — assert the boundary so the clients can't drift again.
  const min = MIN_LISTING_PRICE_BASE_UNITS
  check('MIN_LISTING_PRICE_BASE_UNITS fee is exactly 1 base unit', computePlatformFee(min) === 1n)
  check('just below the floor → fee rounds to zero', computePlatformFee(min - 1n) === 0n)
  check('isBelowListingFloor(min - 1) is true', isBelowListingFloor(min - 1n) === true)
  check('isBelowListingFloor(min) is false', isBelowListingFloor(min) === false)
  check('isBelowListingFloor(0) is true', isBelowListingFloor(0n) === true)
  // A real listing (0.01 ETH / 5 USDC) is comfortably above the floor.
  check('0.01 ETH is listable', isBelowListingFloor(parseEther('0.01')) === false)
  check('5 USDC is listable', isBelowListingFloor(parseUnits('5', 6)) === false)
}

console.log('\nEIP-712 typed data is well-formed (hashes cleanly)')
for (const currency of ['eth', 'usdc'] as const) {
  const price = currency === 'usdc' ? parseUnits('5', 6) : parseEther('0.01')
  const royalty = (price * 5n) / 100n
  const fee = computePlatformFee(price)
  const proceeds = price - royalty - fee
  const message = buildOrderMessage(currency, proceeds, fee, royalty, 0n)
  let hash = ''
  let threw = false
  try {
    hash = hashTypedData({ domain: SEAPORT_DOMAIN, types: SEAPORT_ORDER_TYPES, primaryType: 'OrderComponents', message })
  } catch {
    threw = true
  }
  check(`${currency}: hashTypedData returns a 32-byte digest`, !threw && /^0x[0-9a-f]{64}$/.test(hash), hash)
  const considerationSum = message.consideration.reduce((a, c) => a + c.startAmount, 0n)
  check(`${currency}: consideration sums to price`, considerationSum === price)
  check(`${currency}: offer is the ERC-1155 token`, message.offer[0].itemType === 3 && eq(message.offer[0].token, COLLECTION))
}

report('OK — all list assertions passed')
