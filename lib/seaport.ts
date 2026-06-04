import {
  decodeEventLog,
  hashStruct,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem'
import { usdcAddress } from './zoraMint'
import { BASE_CHAIN_ID, getChain } from './chains'

// Seaport 1.5 — same deterministic address on Base and Ethereum mainnet. The
// per-chain difference is the EIP-712 domain's chainId (see seaportDomain).
export const SEAPORT_ADDRESS: Address = getChain(BASE_CHAIN_ID).seaport

const ItemType = {
  NATIVE: 0,
  ERC20: 1,
  ERC721: 2,
  ERC1155: 3,
} as const

const SeaportOrderType = {
  FULL_OPEN: 0,
} as const

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface OfferItem {
  itemType: number
  token: Address
  identifierOrCriteria: bigint
  startAmount: bigint
  endAmount: bigint
}

interface ConsiderationItem {
  itemType: number
  token: Address
  identifierOrCriteria: bigint
  startAmount: bigint
  endAmount: bigint
  recipient: Address
}

export interface OrderComponents {
  offerer: Address
  zone: Address
  offer: OfferItem[]
  consideration: ConsiderationItem[]
  orderType: number
  startTime: bigint
  endTime: bigint
  zoneHash: Hex
  salt: bigint
  conduitKey: Hex
  counter: bigint
}

// Serialized (BigInt → string) for JSON/Redis storage
interface SerializedOfferItem {
  itemType: number
  token: string
  identifierOrCriteria: string
  startAmount: string
  endAmount: string
}

interface SerializedConsiderationItem {
  itemType: number
  token: string
  identifierOrCriteria: string
  startAmount: string
  endAmount: string
  recipient: string
}

export interface SerializedOrderComponents {
  offerer: string
  zone: string
  offer: SerializedOfferItem[]
  consideration: SerializedConsiderationItem[]
  orderType: number
  startTime: string
  endTime: string
  zoneHash: string
  salt: string
  conduitKey: string
  counter: string
}

// ─── EIP-712 ────────────────────────────────────────────────────────────────

// Per-chain Seaport EIP-712 domain. The chainId binds an order to one chain —
// a Base listing signature can't be replayed to fill on mainnet and vice versa.
export function seaportDomain(chainId: number = BASE_CHAIN_ID) {
  return {
    name: 'Seaport' as const,
    version: '1.5' as const,
    chainId,
    verifyingContract: SEAPORT_ADDRESS,
  }
}

// Back-compat — the Base Seaport domain. Prefer seaportDomain(listing.chainId).
export const SEAPORT_DOMAIN = seaportDomain(BASE_CHAIN_ID)

export const SEAPORT_ORDER_TYPES = {
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

// ─── ABIs ────────────────────────────────────────────────────────────────────

export const SEAPORT_ABI = [
  {
    name: 'getCounter',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'offerer', type: 'address' }],
    outputs: [{ name: 'counter', type: 'uint256' }],
  },
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
              {
                name: 'offer',
                type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                ],
              },
              {
                name: 'consideration',
                type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                  { name: 'recipient', type: 'address' },
                ],
              },
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
  {
    name: 'cancel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'orders',
        type: 'tuple[]',
        components: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          {
            name: 'offer',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
            ],
          },
          {
            name: 'consideration',
            type: 'tuple[]',
            components: [
              { name: 'itemType', type: 'uint8' },
              { name: 'token', type: 'address' },
              { name: 'identifierOrCriteria', type: 'uint256' },
              { name: 'startAmount', type: 'uint256' },
              { name: 'endAmount', type: 'uint256' },
              { name: 'recipient', type: 'address' },
            ],
          },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'counter', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'cancelled', type: 'bool' }],
  },
] as const

export const ERC1155_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isApprovedForAll',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'setApprovalForAll',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
  },
  {
    name: 'safeTransferFrom',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'id', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

export const EIP2981_ABI = [
  {
    name: 'royaltyInfo',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'salePrice', type: 'uint256' },
    ],
    outputs: [
      { name: 'receiver', type: 'address' },
      { name: 'royaltyAmount', type: 'uint256' },
    ],
  },
] as const

// ─── Order builder ───────────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
const THIRTY_DAYS = 30n * 24n * 60n * 60n

export function buildSellOrder({
  offerer,
  collectionAddress,
  tokenId,
  sellerProceeds,
  royaltyReceiver,
  royaltyAmount,
  counter,
  currency = 'eth',
  chainId = BASE_CHAIN_ID,
}: {
  offerer: Address
  collectionAddress: Address
  tokenId: string
  sellerProceeds: bigint
  royaltyReceiver: Address
  royaltyAmount: bigint
  counter: bigint
  currency?: 'eth' | 'usdc'
  /** Target chain for USDC token resolution. Defaults to Base. */
  chainId?: number
}): OrderComponents {
  const now = BigInt(Math.floor(Date.now() / 1000))

  // Consideration items declare WHAT the buyer pays. ETH listings use NATIVE
  // (token = 0x0, value sent with fulfillOrder). USDC listings use ERC20
  // (token = the chain's USDC, no value; Seaport pulls USDC via transferFrom
  // after the buyer approves it). The signed order hash includes these items,
  // so an ETH order can never be filled with USDC and vice versa.
  const isUsdc = currency === 'usdc'
  const considerationItemType = isUsdc ? ItemType.ERC20 : ItemType.NATIVE
  const considerationToken: Address = isUsdc ? usdcAddress(chainId) : ZERO_ADDRESS

  const consideration: ConsiderationItem[] = [
    {
      itemType: considerationItemType,
      token: considerationToken,
      identifierOrCriteria: 0n,
      startAmount: sellerProceeds,
      endAmount: sellerProceeds,
      recipient: offerer,
    },
  ]

  if (royaltyAmount > 0n) {
    consideration.push({
      itemType: considerationItemType,
      token: considerationToken,
      identifierOrCriteria: 0n,
      startAmount: royaltyAmount,
      endAmount: royaltyAmount,
      recipient: royaltyReceiver,
    })
  }

  const saltBytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(saltBytes)
  }
  const salt = saltBytes.reduce((acc, byte, i) => acc + BigInt(byte) * (256n ** BigInt(i)), 0n)

  return {
    offerer,
    zone: ZERO_ADDRESS,
    offer: [
      {
        itemType: ItemType.ERC1155,
        token: collectionAddress,
        identifierOrCriteria: BigInt(tokenId),
        startAmount: 1n,
        endAmount: 1n,
      },
    ],
    consideration,
    orderType: SeaportOrderType.FULL_OPEN,
    startTime: now,
    endTime: now + THIRTY_DAYS,
    zoneHash: ZERO_BYTES32,
    salt,
    conduitKey: ZERO_BYTES32,
    counter,
  }
}

// ─── Serialization ───────────────────────────────────────────────────────────

export function serializeOrder(order: OrderComponents): SerializedOrderComponents {
  return {
    offerer: order.offerer,
    zone: order.zone,
    offer: order.offer.map((item) => ({
      itemType: item.itemType,
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
    })),
    consideration: order.consideration.map((item) => ({
      itemType: item.itemType,
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
      recipient: item.recipient,
    })),
    orderType: order.orderType,
    startTime: order.startTime.toString(),
    endTime: order.endTime.toString(),
    zoneHash: order.zoneHash,
    salt: order.salt.toString(),
    conduitKey: order.conduitKey,
    counter: order.counter.toString(),
  }
}

export function deserializeOrder(order: SerializedOrderComponents): OrderComponents {
  return {
    offerer: order.offerer as Address,
    zone: order.zone as Address,
    offer: order.offer.map((item) => ({
      itemType: item.itemType,
      token: item.token as Address,
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
    })),
    consideration: order.consideration.map((item) => ({
      itemType: item.itemType,
      token: item.token as Address,
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
      recipient: item.recipient as Address,
    })),
    orderType: order.orderType,
    startTime: BigInt(order.startTime),
    endTime: BigInt(order.endTime),
    zoneHash: order.zoneHash as Hex,
    salt: BigInt(order.salt),
    conduitKey: order.conduitKey as Hex,
    counter: BigInt(order.counter),
  }
}

// ─── Receipt-anchored status verification ────────────────────────────────────

/**
 * Seaport's on-chain orderHash is the EIP-712 struct hash of the
 * OrderComponents — keccak256(typeHash || encodeData(components)), with NO
 * domain separator. viem's hashStruct produces exactly that.
 *
 * Used to match a transaction's OrderFulfilled / OrderCancelled event back
 * to a specific listing: any receipt log whose first topic is the event sig
 * and whose first data field is this hash refers to this order.
 */
function deriveOrderHash(order: OrderComponents): Hex {
  return hashStruct({
    types: SEAPORT_ORDER_TYPES,
    primaryType: 'OrderComponents',
    data: order,
  })
}

// Seaport 1.5 OrderFulfilled signature. `offerer` and `zone` are indexed
// (topics 1+2); orderHash, recipient, and the offer/consideration arrays
// live in `data`. decodeEventLog handles both.
//
// OrderCancelled is intentionally not decoded server-side: cancellation
// remains signature-only so a seller can "soft cancel" without paying
// gas to call Seaport.cancel — the listing leaves the platform feed but
// the underlying on-chain order is still fulfillable. Fulfillment is
// the asymmetric-harm side (a third party can grief any listing), so
// only that path requires the receipt anchor.
const ORDER_FULFILLED_EVENT = parseAbiItem(
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)',
)

interface ListingLike {
  orderComponents: SerializedOrderComponents
}

/**
 * Scan a transaction receipt for a Seaport fulfillment event matching
 * `listing.orderComponents`. Returns the on-chain recipient (msg.sender of
 * fulfillOrder) on a match, or null otherwise.
 *
 * Match conditions:
 *   - Log emitted by SEAPORT_ADDRESS (no other contract's events count)
 *   - Decodes as OrderFulfilled
 *   - First data field (orderHash) equals deriveOrderHash(listing)
 *
 * Caller is expected to also check that the returned recipient matches the
 * signer of the PATCH so a third party can't co-opt someone else's purchase.
 */
export function findFulfillmentInLogs(
  listing: ListingLike,
  logs: ReadonlyArray<{ address: string; topics: readonly Hex[]; data: Hex }>,
): { recipient: Address } | null {
  const expected = deriveOrderHash(deserializeOrder(listing.orderComponents))
  for (const log of logs) {
    if (log.address.toLowerCase() !== SEAPORT_ADDRESS.toLowerCase()) continue
    let decoded
    try {
      decoded = decodeEventLog({
        abi: [ORDER_FULFILLED_EVENT],
        data: log.data,
        // decodeEventLog requires a mutable [signature, ...indexed] tuple
        topics: log.topics as unknown as [signature: Hex, ...args: Hex[]],
      })
    } catch {
      continue
    }
    if (decoded.args.orderHash !== expected) continue
    return { recipient: decoded.args.recipient }
  }
  return null
}

