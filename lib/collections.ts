import { encodeFunctionData, type Address } from 'viem'

// Zora's canonical 1155 Factory Proxy — same address on every chain Zora supports
// (deterministic CREATE2 deploy with the 0x777777 vanity prefix).
// inprocess's docs reference 0x6832A997… inside a Coinbase CDP smart-account /
// paymaster user-operation flow, which is not the EOA path used by this app —
// that address has no code on Base mainnet (verified via eth_getCode).
export const FACTORY_ADDRESS = '0x777777C338d93e2C7adf08D102d45CA7CC4Ed021' as const

// Minimal ABI fragment for the Zora 1155 collection contract's permission function.
// tokenId=0 means collection-wide; permissionBits=2 is PERMISSION_BIT_MINTER.
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
    args: [0n, minterAddress, 2n],
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
