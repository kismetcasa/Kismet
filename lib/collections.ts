import { encodeFunctionData, type Address } from 'viem'

// inprocess's Base Mainnet ZORA 1155 Contract Factory.
// Source: https://github.com/sweetmantech/docs-in-process/blob/main/docs/pages/protocol-deployments.mdx
// (Sepolia testnet uses 0x6832A997D8616707C7b68721D6E9332E77da7F6C — different
// address; the testnet address has no code on Base mainnet, which is why every
// previous deploy attempt confirmed on-chain but emitted no SetupNewContract.)
// This is Zora's factory bytecode (verified on basescan), so our FACTORY_ABI
// matches; using the inprocess-documented deployment ensures the resulting
// collection is tracked by their indexer + their /api/mint and /api/airdrop
// services work against it.
export const FACTORY_ADDRESS = '0x540C18B7f99b3b599c6FeB99964498931c211858' as const

// Minimal ABI fragment for the Zora 1155 collection contract's permission function.
// tokenId=0 means collection-wide; permissionBits=4 is PERMISSION_BIT_MINTER.
// Per Zora's PermissionsConstants: ADMIN=2, MINTER=4, SALES=8, METADATA=16,
// FUNDS_MANAGER=32. Granting MINTER lets the address mint but does NOT let
// them transfer admin or change the royalty config.
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
] as const

export function encodeMinterPermission(minterAddress: Address): `0x${string}` {
  return encodeFunctionData({
    abi: COLLECTION_ABI,
    functionName: 'addPermission',
    args: [0n, minterAddress, 4n],
  })
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
