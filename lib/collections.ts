import { encodeFunctionData, toEventSelector, type Address, type AbiEvent } from 'viem'
import { ZORA_FIXED_PRICE_STRATEGY } from './zoraMint'

// inprocess's Base Mainnet ZORA 1155 Contract Factory.
// Source: https://github.com/sweetmantech/docs-in-process/blob/main/docs/pages/protocol-deployments.mdx
// (Sepolia testnet uses 0x6832A997D8616707C7b68721D6E9332E77da7F6C — different
// address; the testnet address has no code on Base mainnet, which is why every
// previous deploy attempt confirmed on-chain but emitted no SetupNewContract.)
// This is Zora's factory bytecode (verified on basescan), so our FACTORY_ABI
// matches; using the inprocess-documented deployment ensures the resulting
// collection is tracked by their indexer.
export const FACTORY_ADDRESS = '0x540C18B7f99b3b599c6FeB99964498931c211858' as const

// Zora's Fixed Price Sale Strategy on Base mainnet — single source of truth
// in lib/zoraMint.ts. Re-exported as a local const here so deploy + collect
// stay in lockstep: the address granted MINTER permission during deploy must
// match the one called from useDirectCollect.
const FIXED_PRICE_STRATEGY_ADDRESS = ZORA_FIXED_PRICE_STRATEGY

// Open-edition supply (max uint64) — used when no supply cap specified.
// Matches inprocess's OPEN_EDITION_MINT_SIZE.
const OPEN_EDITION_MINT_SIZE = 18446744073709551615n

// Per Zora's PermissionsConstants: ADMIN=2, MINTER=4, SALES=8, METADATA=16,
// FUNDS_MANAGER=32. Canonical exports live in lib/permissions.ts; this
// file imports them only for use in encodeAdminPermission /
// encodeMinterPermission below. All other call-sites import the
// constants from @/lib/permissions directly.
import {
  PERMISSION_BIT_ADMIN,
  PERMISSION_BIT_MINTER,
} from './permissions'

const COLLECTION_ABI = [
  {
    name: 'addPermission',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
      { name: 'permissionBits', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'removePermission',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
      { name: 'permissionBits', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'UpdatedPermissions',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'user', type: 'address', indexed: true },
      { name: 'permissions', type: 'uint256', indexed: true },
    ],
    anonymous: false,
  },
  {
    name: 'assumeLastTokenIdMatches',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'setupNewTokenWithCreateReferral',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'newURI', type: 'string' },
      { name: 'maxSupply', type: 'uint256' },
      { name: 'createReferral', type: 'address' },
    ],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    name: 'callSale',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'salesConfig', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'adminMint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'quantity', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'permissions',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const FIXED_PRICE_SALE_STRATEGY_ABI = [
  {
    name: 'setSale',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        type: 'tuple',
        name: 'salesConfig',
        components: [
          { name: 'saleStart', type: 'uint64' },
          { name: 'saleEnd', type: 'uint64' },
          { name: 'maxTokensPerAddress', type: 'uint64' },
          { name: 'pricePerToken', type: 'uint96' },
          { name: 'fundsRecipient', type: 'address' },
        ],
      },
    ],
    outputs: [],
  },
] as const

// Grant collection-wide MINTER permission to an address. Encoded as a setup
// action passed to createContract — the factory replays it on the new
// collection during deploy.
export function encodeMinterPermission(minterAddress: Address): `0x${string}` {
  return encodeFunctionData({
    abi: COLLECTION_ABI,
    functionName: 'addPermission',
    args: [0n, minterAddress, PERMISSION_BIT_MINTER],
  })
}

// Grant collection-wide ADMIN permission to an address. We use this to
// authorize the inprocess platform smart wallet so that subsequent
// /api/mint calls (which submit userOps via that smart wallet) can run
// setupNewToken without reverting at gas estimation. Same encoding as
// encodeMinterPermission but with the ADMIN bit (2) instead of MINTER (4).
export function encodeAdminPermission(adminAddress: Address): `0x${string}` {
  return encodeFunctionData({
    abi: COLLECTION_ABI,
    functionName: 'addPermission',
    args: [0n, adminAddress, PERMISSION_BIT_ADMIN],
  })
}

// Re-export the ABI fragment for the read+write pieces consumers need
// outside this module: `permissions` (read) for "is this address already
// admin?" checks, and `addPermission` (write) for the retroactive
// authorize flow on existing collections.
export { COLLECTION_ABI }

// keccak256("UpdatedPermissions(uint256,address,uint256)") — Zora's
// canonical 1155 event signature, hardcoded so a typo in the ABI
// definition above (wrong type, swapped args) fails loudly at module
// load instead of silently returning empty log queries. Cross-checked
// against Zora's ZoraCreator1155Impl on Base; bump this constant if
// Zora ever ships a contract upgrade that changes the signature.
export const UPDATED_PERMISSIONS_TOPIC =
  '0x35fb03d0d293ef5b362761900725ce891f8f766b5a662cdd445372355448e7ca' as const

const UPDATED_PERMISSIONS_EVENT = COLLECTION_ABI.find(
  (item) => item.type === 'event' && item.name === 'UpdatedPermissions',
) as AbiEvent | undefined

if (UPDATED_PERMISSIONS_EVENT) {
  const computed = toEventSelector(UPDATED_PERMISSIONS_EVENT)
  if (computed !== UPDATED_PERMISSIONS_TOPIC) {
    console.error(
      `[collections] UpdatedPermissions ABI drifted: computed ${computed}, expected ${UPDATED_PERMISSIONS_TOPIC}. ` +
        `findMintableCollections will return empty results until reconciled.`,
    )
  }
}

interface CoverTokenSetupParams {
  tokenURI: string
  maxSupply?: bigint
  createReferral: Address
  pricePerTokenWei: bigint
  saleStart: bigint
  saleEnd: bigint
  fundsRecipient: Address
  creator: Address
  mintToCreatorCount?: number
}

// Builds the setupActions sequence Zora's factory replays on a new collection
// to create + sell + (optionally) mint copies of the cover token in the same
// deploy transaction. Mirrors the order used by inprocess's frontend SDK
// (lib/protocolSdk/create/token-setup.ts:142-167 in their public repo).
//
// The factory itself acts as transient admin during deploy, so this requires
// no permissions on the new collection beyond what defaultAdmin grants
// implicitly. Once deploy completes, only the user (defaultAdmin) has admin.
export function buildCoverTokenSetupActions(
  params: CoverTokenSetupParams,
): `0x${string}`[] {
  const tokenId = 1n // first token in a fresh collection always has id 1
  const maxSupply = params.maxSupply ?? OPEN_EDITION_MINT_SIZE
  const mintCount = params.mintToCreatorCount ?? 1

  const actions: `0x${string}`[] = []

  // 1. Sanity check: assert we're starting from token #0, so the new token will
  //    actually be #1. If anything else is true, the entire deploy reverts.
  actions.push(
    encodeFunctionData({
      abi: COLLECTION_ABI,
      functionName: 'assumeLastTokenIdMatches',
      args: [0n],
    }),
  )

  // 2. Create the token with its metadata URI and supply cap.
  actions.push(
    encodeFunctionData({
      abi: COLLECTION_ABI,
      functionName: 'setupNewTokenWithCreateReferral',
      args: [params.tokenURI, maxSupply, params.createReferral],
    }),
  )

  // 3. Grant MINTER permission to the FixedPrice sale strategy for this token.
  actions.push(
    encodeFunctionData({
      abi: COLLECTION_ABI,
      functionName: 'addPermission',
      args: [tokenId, FIXED_PRICE_STRATEGY_ADDRESS, PERMISSION_BIT_MINTER],
    }),
  )

  // 4. Configure the sale: price + window + fundsRecipient.
  const saleData = encodeFunctionData({
    abi: FIXED_PRICE_SALE_STRATEGY_ABI,
    functionName: 'setSale',
    args: [
      tokenId,
      {
        saleStart: params.saleStart,
        saleEnd: params.saleEnd,
        maxTokensPerAddress: 0n, // 0 = unlimited per address
        pricePerToken: params.pricePerTokenWei,
        fundsRecipient: params.fundsRecipient,
      },
    ],
  })
  actions.push(
    encodeFunctionData({
      abi: COLLECTION_ABI,
      functionName: 'callSale',
      args: [tokenId, FIXED_PRICE_STRATEGY_ADDRESS, saleData],
    }),
  )

  // 5. (Optional) admin-mint a copy to the creator.
  if (mintCount > 0) {
    actions.push(
      encodeFunctionData({
        abi: COLLECTION_ABI,
        functionName: 'adminMint',
        args: [params.creator, tokenId, BigInt(mintCount), '0x' as `0x${string}`],
      }),
    )
  }

  return actions
}

export const FACTORY_ABI = [
  {
    inputs: [
      { internalType: 'string', name: 'newContractURI', type: 'string' },
      { internalType: 'string', name: 'name', type: 'string' },
      {
        components: [
          { internalType: 'uint32', name: 'royaltyMintSchedule', type: 'uint32' },
          { internalType: 'uint32', name: 'royaltyBPS', type: 'uint32' },
          { internalType: 'address', name: 'royaltyRecipient', type: 'address' },
        ],
        internalType: 'struct ICreatorRoyaltiesControl.RoyaltyConfiguration',
        name: 'defaultRoyaltyConfiguration',
        type: 'tuple',
      },
      { internalType: 'address payable', name: 'defaultAdmin', type: 'address' },
      { internalType: 'bytes[]', name: 'setupActions', type: 'bytes[]' },
    ],
    name: 'createContract',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'newContract', type: 'address' },
      { indexed: true, internalType: 'address', name: 'creator', type: 'address' },
      { indexed: true, internalType: 'address', name: 'defaultAdmin', type: 'address' },
      { indexed: false, internalType: 'string', name: 'contractURI', type: 'string' },
      { indexed: false, internalType: 'string', name: 'name', type: 'string' },
      {
        components: [
          { internalType: 'uint32', name: 'royaltyMintSchedule', type: 'uint32' },
          { internalType: 'uint32', name: 'royaltyBPS', type: 'uint32' },
          { internalType: 'address', name: 'royaltyRecipient', type: 'address' },
        ],
        indexed: false,
        internalType: 'struct ICreatorRoyaltiesControl.RoyaltyConfiguration',
        name: 'defaultRoyaltyConfiguration',
        type: 'tuple',
      },
    ],
    name: 'SetupNewContract',
    type: 'event',
  },
] as const
