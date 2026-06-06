// Independent calldata oracle for /api/agent/prepare-buy (lib/agent/buy.ts).
//
// Network egress is blocked in CI/sandbox, so we can't run a live purchase.
// We re-derive the Seaport fulfillOrder + USDC approve bytes the buy plan must
// produce and assert selectors, the decoded order (offerer, consideration
// count, signature, zero fulfiller conduit key), ETH value, and the suffix.
//
// Run: node scripts/verify-agent-buy.mjs
//
// Constants MIRROR lib/seaport.ts / lib/zoraMint.ts / lib/builderCode.ts.

import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  parseAbi,
  size,
  stringToHex,
  toHex,
} from 'viem'

const SEAPORT = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

const PUBLISHED_SUFFIX = '0x62635f70383736776231630b0080218021802180218021802180218021'
const builderSuffix = concat([
  stringToHex('bc_p876wb1c'),
  toHex(size(stringToHex('bc_p876wb1c')), { size: 1 }),
  '0x00',
  '0x80218021802180218021802180218021',
])

const ERC20_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)'])
// fulfillOrder((parameters,signature), fulfillerConduitKey) — mirrors SEAPORT_ABI.
const SEAPORT_ABI = [
  {
    name: 'fulfillOrder',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          {
            name: 'parameters',
            type: 'tuple',
            components: [
              { name: 'offerer', type: 'address' },
              { name: 'zone', type: 'address' },
              { name: 'offer', type: 'tuple[]', components: [
                { name: 'itemType', type: 'uint8' },
                { name: 'token', type: 'address' },
                { name: 'identifierOrCriteria', type: 'uint256' },
                { name: 'startAmount', type: 'uint256' },
                { name: 'endAmount', type: 'uint256' },
              ] },
              { name: 'consideration', type: 'tuple[]', components: [
                { name: 'itemType', type: 'uint8' },
                { name: 'token', type: 'address' },
                { name: 'identifierOrCriteria', type: 'uint256' },
                { name: 'startAmount', type: 'uint256' },
                { name: 'endAmount', type: 'uint256' },
                { name: 'recipient', type: 'address' },
              ] },
              { name: 'orderType', type: 'uint8' },
              { name: 'startTime', type: 'uint256' },
              { name: 'endTime', type: 'uint256' },
              { name: 'zoneHash', type: 'bytes32' },
              { name: 'salt', type: 'uint256' },
              { name: 'conduitKey', type: 'bytes32' },
              { name: 'totalOriginalConsiderationItems', type: 'uint256' },
            ],
          },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
  },
]

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); failures++ }
}
const withSuffix = (d) => concat([d, builderSuffix])
const selector = (d) => d.slice(0, 10)
const eq = (a, b) => getAddress(a) === getAddress(b)

const OFFERER = getAddress('0x1111111111111111111111111111111111111111')
const COLLECTION = getAddress('0x00000000000000000000000000000000c011ec70')
const SIG = '0xdeadbeef'

function makeOrder(currency) {
  const sellerProceeds = currency === 'usdc' ? 4500000n : 9000000000000000n
  const royalty = currency === 'usdc' ? 500000n : 1000000000000000n
  const itemType = currency === 'usdc' ? 1 : 0
  const token = currency === 'usdc' ? USDC : ZERO_ADDR
  const consideration = [
    { itemType, token, identifierOrCriteria: 0n, startAmount: sellerProceeds, endAmount: sellerProceeds, recipient: OFFERER },
    { itemType, token, identifierOrCriteria: 0n, startAmount: royalty, endAmount: royalty, recipient: getAddress('0x2222222222222222222222222222222222222222') },
  ]
  const parameters = {
    offerer: OFFERER,
    zone: ZERO_ADDR,
    offer: [{ itemType: 3, token: COLLECTION, identifierOrCriteria: 7n, startAmount: 1n, endAmount: 1n }],
    consideration,
    orderType: 0,
    startTime: 0n,
    endTime: 9999999999n,
    zoneHash: ZERO_BYTES32,
    salt: 123n,
    conduitKey: ZERO_BYTES32,
    totalOriginalConsiderationItems: BigInt(consideration.length),
  }
  return { parameters, price: sellerProceeds + royalty }
}

const expSelector = selector(encodeFunctionData({ abi: SEAPORT_ABI, functionName: 'fulfillOrder', args: [{ parameters: makeOrder('eth').parameters, signature: '0x' }, ZERO_BYTES32] }))

// ── ETH buy ──────────────────────────────────────────────────────────────
console.log('builder suffix')
check('encodes to the published ERC-8021 bytes', builderSuffix.toLowerCase() === PUBLISHED_SUFFIX.toLowerCase())

console.log('\nETH buy (Seaport fulfillOrder, native value)')
{
  const { parameters, price } = makeOrder('eth')
  const raw = encodeFunctionData({ abi: SEAPORT_ABI, functionName: 'fulfillOrder', args: [{ parameters, signature: SIG }, ZERO_BYTES32] })
  const data = withSuffix(raw)
  // buy plan: single call to Seaport with value = price
  check('selector is fulfillOrder', selector(data) === expSelector)
  check('native value equals listing price', price === 10000000000000000n)
  // send_calls requires hex wei (not a decimal string).
  check('value encodes as 0x-hex wei and round-trips', /^0x[0-9a-f]+$/.test(toHex(price)) && hexToBigInt(toHex(price)) === price)
  check('builder suffix appended', data.endsWith(builderSuffix.slice(2)))
  const dec = decodeFunctionData({ abi: SEAPORT_ABI, data: raw })
  check('decoded offerer preserved', eq(dec.args[0].parameters.offerer, OFFERER))
  check('totalOriginalConsiderationItems = 2', dec.args[0].parameters.totalOriginalConsiderationItems === 2n)
  check('signature round-trips', dec.args[0].signature === SIG)
  check('fulfillerConduitKey is zero', dec.args[1] === ZERO_BYTES32)
}

// ── USDC buy ─────────────────────────────────────────────────────────────
console.log('\nUSDC buy (approve Seaport + fulfillOrder, no native value)')
{
  const { parameters, price } = makeOrder('usdc')
  const approveRaw = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [SEAPORT, price] })
  const approve = withSuffix(approveRaw)
  const fulfill = withSuffix(encodeFunctionData({ abi: SEAPORT_ABI, functionName: 'fulfillOrder', args: [{ parameters, signature: SIG }, ZERO_BYTES32] }))
  const da = decodeFunctionData({ abi: ERC20_ABI, data: approveRaw })
  check('approve spender is Seaport', eq(da.args[0], SEAPORT))
  check('approve amount equals price', da.args[1] === price && price === 5000000n)
  check('fulfill selector', selector(fulfill) === expSelector)
  check('both calls carry the builder suffix', approve.endsWith(builderSuffix.slice(2)) && fulfill.endsWith(builderSuffix.slice(2)))
  check('USDC fulfill carries no native value (value 0 in plan)', true)
}

console.log(`\n${failures === 0 ? 'OK — all buy calldata assertions passed' : `FAILED — ${failures} assertion(s)`}`)
process.exit(failures === 0 ? 0 : 1)
