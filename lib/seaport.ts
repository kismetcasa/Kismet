import type { Address, Hex } from 'viem'

// Seaport 1.5 — deployed on Base mainnet
export const SEAPORT_ADDRESS = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC' as const

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

export const SEAPORT_DOMAIN = {
  name: 'Seaport' as const,
  version: '1.5' as const,
  chainId: 8453,
  verifyingContract: SEAPORT_ADDRESS,
}

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
}: {
  offerer: Address
  collectionAddress: Address
  tokenId: string
  sellerProceeds: bigint
  royaltyReceiver: Address
  royaltyAmount: bigint
  counter: bigint
}): OrderComponents {
  const now = BigInt(Math.floor(Date.now() / 1000))

  const consideration: ConsiderationItem[] = [
    {
      itemType: ItemType.NATIVE,
      token: ZERO_ADDRESS,
      identifierOrCriteria: 0n,
      startAmount: sellerProceeds,
      endAmount: sellerProceeds,
      recipient: offerer,
    },
  ]

  if (royaltyAmount > 0n) {
    consideration.push({
      itemType: ItemType.NATIVE,
      token: ZERO_ADDRESS,
      identifierOrCriteria: 0n,
      startAmount: royaltyAmount,
      endAmount: royaltyAmount,
      recipient: royaltyReceiver,
    })
  }

  // Random salt
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
