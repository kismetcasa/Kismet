#!/usr/bin/env node
// Verify lib/seaport.ts deriveOrderHash() produces the canonical Seaport
// orderHash. deriveOrderHash uses viem's hashStruct over the OrderComponents
// EIP-712 type; the listing-PATCH receipt check (app/api/listings/[id]) relies
// on it matching the orderHash Seaport emits in OrderFulfilled, so a silent
// drift here would make every real sale fail the on-chain verification.
//
// This script computes the hash two INDEPENDENT ways for a fixed sample order:
//   1. viem hashStruct — the exact call deriveOrderHash makes.
//   2. A hand-rolled EIP-712 struct hash (manual typeHash + abi.encode), which
//      is what Seaport's _deriveOrderHash does on-chain.
// If they disagree, viem's typed-data engine and/or our type definitions have
// drifted from the canonical encoding. A pinned EXPECTED constant additionally
// catches any change that alters the output for this sample.
//
// No network / RPC needed. Usage: node scripts/verify-seaport-orderhash.mjs
// Exits 0 on match, non-zero otherwise.

import {
  hashStruct,
  keccak256,
  encodeAbiParameters,
  toHex,
  concat,
} from 'viem'

// MUST mirror SEAPORT_ORDER_TYPES in lib/seaport.ts.
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
}

// Deterministic sample order — fixed values so the output is reproducible.
const order = {
  offerer: '0x1111111111111111111111111111111111111111',
  zone: '0x0000000000000000000000000000000000000000',
  offer: [
    {
      itemType: 3,
      token: '0x2222222222222222222222222222222222222222',
      identifierOrCriteria: 42n,
      startAmount: 1n,
      endAmount: 1n,
    },
  ],
  consideration: [
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: 0n,
      startAmount: 1000000000000000000n,
      endAmount: 1000000000000000000n,
      recipient: '0x1111111111111111111111111111111111111111',
    },
    {
      itemType: 0,
      token: '0x0000000000000000000000000000000000000000',
      identifierOrCriteria: 0n,
      startAmount: 50000000000000000n,
      endAmount: 50000000000000000n,
      recipient: '0x3333333333333333333333333333333333333333',
    },
  ],
  orderType: 0,
  startTime: 1700000000n,
  endTime: 1700086400n,
  zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
  salt: 12345n,
  conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
  counter: 0n,
}

// ── Method 1: viem hashStruct (what deriveOrderHash uses) ──────────────────
const viaHashStruct = hashStruct({
  types: SEAPORT_ORDER_TYPES,
  primaryType: 'OrderComponents',
  data: order,
})

// ── Method 2: hand-rolled canonical EIP-712 struct hash ────────────────────
const OFFER_ITEM_TYPESTRING =
  'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)'
const CONSIDERATION_ITEM_TYPESTRING =
  'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)'
const ORDER_COMPONENTS_TYPESTRING =
  'OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)' +
  CONSIDERATION_ITEM_TYPESTRING +
  OFFER_ITEM_TYPESTRING

const offerItemTypeHash = keccak256(toHex(OFFER_ITEM_TYPESTRING))
const considerationItemTypeHash = keccak256(toHex(CONSIDERATION_ITEM_TYPESTRING))
const orderComponentsTypeHash = keccak256(toHex(ORDER_COMPONENTS_TYPESTRING))

function hashOfferItem(item) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' }, // itemType (uint8 encodes in a 32-byte word)
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
      ],
      [
        offerItemTypeHash,
        BigInt(item.itemType),
        item.token,
        item.identifierOrCriteria,
        item.startAmount,
        item.endAmount,
      ],
    ),
  )
}

function hashConsiderationItem(item) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        considerationItemTypeHash,
        BigInt(item.itemType),
        item.token,
        item.identifierOrCriteria,
        item.startAmount,
        item.endAmount,
        item.recipient,
      ],
    ),
  )
}

const offerArrayHash = keccak256(concat(order.offer.map(hashOfferItem)))
const considerationArrayHash = keccak256(
  concat(order.consideration.map(hashConsiderationItem)),
)

const manual = keccak256(
  encodeAbiParameters(
    [
      { type: 'bytes32' }, // typeHash
      { type: 'address' }, // offerer
      { type: 'address' }, // zone
      { type: 'bytes32' }, // keccak(offer)
      { type: 'bytes32' }, // keccak(consideration)
      { type: 'uint256' }, // orderType
      { type: 'uint256' }, // startTime
      { type: 'uint256' }, // endTime
      { type: 'bytes32' }, // zoneHash
      { type: 'uint256' }, // salt
      { type: 'bytes32' }, // conduitKey
      { type: 'uint256' }, // counter
    ],
    [
      orderComponentsTypeHash,
      order.offerer,
      order.zone,
      offerArrayHash,
      considerationArrayHash,
      BigInt(order.orderType),
      order.startTime,
      order.endTime,
      order.zoneHash,
      order.salt,
      order.conduitKey,
      order.counter,
    ],
  ),
)

// Pinned regression value for the fixed sample above. Any future change that
// alters the computed hash (type drift, viem behavior change) trips this.
const EXPECTED =
  '0xa4dbe5d4b79a336e36a440d79cd0da107994fb8be48c98bfb4350b9b3c2146bc'

let ok = true
console.log('viem hashStruct:', viaHashStruct)
console.log('manual EIP-712 :', manual)
console.log('pinned expected:', EXPECTED)

if (viaHashStruct !== manual) {
  console.error('FAIL: viem hashStruct disagrees with hand-rolled EIP-712 encoding')
  ok = false
}
if (viaHashStruct !== EXPECTED) {
  console.error('FAIL: orderHash drifted from the pinned regression value')
  ok = false
}

if (!ok) process.exit(1)
console.log('OK: deriveOrderHash matches the canonical Seaport orderHash encoding')
