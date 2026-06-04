import { encodeFunctionData, type Address } from 'viem'
import {
  OPEN_EDITION_MINT_SIZE,
  ZORA_FIXED_PRICE_STRATEGY,
  fixedPriceStrategy,
  erc20Minter,
  usdcAddress,
} from './zoraMint'
import { BASE_CHAIN_ID, getChain } from './chains'

// inprocess's Base Mainnet ZORA 1155 Contract Factory (the `createContract`
// entrypoint). Canonical value lives in the chain registry (lib/chains.ts).
// Source: https://github.com/sweetmantech/docs-in-process/blob/main/docs/pages/protocol-deployments.mdx
// (Sepolia testnet uses 0x6832A997D8616707C7b68721D6E9332E77da7F6C — different
// address; the testnet address has no code on Base mainnet, which is why every
// previous deploy attempt confirmed on-chain but emitted no SetupNewContract.)
// This is Zora's factory bytecode (verified on basescan), so our FACTORY_ABI
// matches; using the inprocess-documented deployment ensures the resulting
// collection is tracked by their indexer.
//
// MULTICHAIN NOTE: this is Base-only. The mainnet `createContract` factory is
// NOT yet verified (getChain(1).factoryVerified === false) — do not point the
// deploy path at mainnet until it is. See MAINNET_EXPANSION_SCOPE.md §1.3.
export const FACTORY_ADDRESS: Address = getChain(BASE_CHAIN_ID).factory

// Zora's Fixed Price Sale Strategy on Base mainnet — single source of truth
// in lib/zoraMint.ts. Re-exported as a local const here so deploy + collect
// stay in lockstep: the address granted MINTER permission during deploy must
// match the one called from useDirectCollect.
const FIXED_PRICE_STRATEGY_ADDRESS = ZORA_FIXED_PRICE_STRATEGY

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
  {
    // The id the NEXT setupNewToken will assign (Zora initializes it to 1;
    // token 0 is the collection-wide permission scope). Read before a
    // client-side mint so we can target the new token's id and guard the
    // batch with assumeLastTokenIdMatches(nextTokenId - 1).
    name: 'nextTokenId',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    // Per-token royalty config. Used to route a token's secondary royalties +
    // creator-reward recipient to a split (so getCreatorRewardRecipient resolves
    // it). Tuple matches ICreatorRoyaltiesControl.RoyaltyConfiguration.
    name: 'updateRoyaltiesForToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      {
        type: 'tuple',
        name: 'newConfiguration',
        components: [
          { name: 'royaltyMintSchedule', type: 'uint32' },
          { name: 'royaltyBPS', type: 'uint32' },
          { name: 'royaltyRecipient', type: 'address' },
        ],
      },
    ],
    outputs: [],
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

// ERC20Minter.setSale — the USDC analog of FIXED_PRICE_SALE_STRATEGY_ABI.
// pricePerToken widens to uint256 and the struct carries a trailing `currency`
// field. Matches ERC20_MINTER_SALE_ABI (the read side) in lib/saleConfig.ts.
const ERC20_MINTER_SET_SALE_ABI = [
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
          { name: 'pricePerToken', type: 'uint256' },
          { name: 'fundsRecipient', type: 'address' },
          { name: 'currency', type: 'address' },
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

interface MomentMintParams {
  tokenURI: string
  maxSupply?: bigint
  createReferral: Address
  pricePerTokenWei: bigint
  saleStart: bigint
  saleEnd: bigint
  /** Sale-proceeds recipient: the creator EOA, or a split contract address. */
  fundsRecipient: Address
  /** Recipient of the admin-minted creator copies (typically the creator EOA). */
  creator: Address
  mintToCreatorCount?: number
  /**
   * The id `setupNewToken` will assign on this collection — read from the
   * collection's `nextTokenId()` immediately before building. The batch is
   * guarded with `assumeLastTokenIdMatches(newTokenId - 1)` so a concurrent
   * create can't shift the id out from under our setSale/adminMint.
   */
  newTokenId: bigint
  /** Target chain — selects the strategy + USDC addresses. Defaults to Base. */
  chainId?: number
  /**
   * Sale currency. 'eth' (default) → FixedPriceSaleStrategy; 'usdc' →
   * ERC20Minter (grants MINTER to the ERC20 strategy and writes the USDC
   * currency into the sale config). `pricePerTokenWei` is base units either way
   * (wei for ETH, 6-decimal units for USDC).
   */
  currency?: 'eth' | 'usdc'
  /**
   * When set, append `updateRoyaltiesForToken` to route secondary royalties +
   * the creator-reward recipient to this address (the split). This is what
   * makes `getCreatorRewardRecipient(tokenId)` resolve the split — the mainnet
   * distribute path (useMomentSplits) relies on it, mirroring In Process on Base.
   */
  royaltyRecipient?: Address
  /** Royalty basis points written alongside `royaltyRecipient` (default 0). */
  royaltyBps?: number
}

// Builds the `multicall(bytes[])` sequence that creates + sells + (optionally)
// mints a copy of a NEW token on an EXISTING collection, submitted directly
// from the user's wallet (see hooks/useClientMint.ts). This is the user-paid
// analog of the In Process /moment/create relay — the path mainnet must use
// since that relay is Base-only (MAINNET_EXPANSION_SCOPE.md §6.1, Phase 4 B).
//
// Identical action SHAPE to buildCoverTokenSetupActions (the deploy-time cover
// token), differing only in (a) the live `newTokenId` instead of a fixed `1`,
// and (b) a chain-keyed strategy address instead of the Base constant. Kept as
// a separate function so the treasury-sensitive deploy path stays byte-for-byte
// unchanged; unify the two if/when this graduates past prototype. The minter's
// EOA must hold collection-wide ADMIN — setupNewToken reverts otherwise (a
// self-deployed collection grants its deployer ADMIN, so this holds for a
// creator minting into their own collection).
export function buildMomentMintActions(params: MomentMintParams): `0x${string}`[] {
  const { newTokenId } = params
  const lastTokenId = newTokenId - 1n
  const maxSupply = params.maxSupply ?? OPEN_EDITION_MINT_SIZE
  const mintCount = params.mintToCreatorCount ?? 1
  const chainId = params.chainId ?? BASE_CHAIN_ID
  // ETH → FixedPriceSaleStrategy; USDC → ERC20Minter. The chosen strategy gets
  // the per-token MINTER grant and is the callSale target.
  const useUsdc = params.currency === 'usdc'
  const strategy = useUsdc ? erc20Minter(chainId) : fixedPriceStrategy(chainId)

  const actions: `0x${string}`[] = []

  // 1. Assert the collection's last token id, so the token we create is
  //    exactly `newTokenId`. Reverts the whole batch on any mismatch.
  actions.push(
    encodeFunctionData({
      abi: COLLECTION_ABI,
      functionName: 'assumeLastTokenIdMatches',
      args: [lastTokenId],
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

  // 3. Grant MINTER permission to the sale strategy for this token.
  actions.push(
    encodeFunctionData({
      abi: COLLECTION_ABI,
      functionName: 'addPermission',
      args: [newTokenId, strategy, PERMISSION_BIT_MINTER],
    }),
  )

  // 4. Configure the sale: price + window + fundsRecipient (+ currency for USDC).
  const saleData = useUsdc
    ? encodeFunctionData({
        abi: ERC20_MINTER_SET_SALE_ABI,
        functionName: 'setSale',
        args: [
          newTokenId,
          {
            saleStart: params.saleStart,
            saleEnd: params.saleEnd,
            maxTokensPerAddress: 0n, // 0 = unlimited per address
            pricePerToken: params.pricePerTokenWei,
            fundsRecipient: params.fundsRecipient,
            currency: usdcAddress(chainId),
          },
        ],
      })
    : encodeFunctionData({
        abi: FIXED_PRICE_SALE_STRATEGY_ABI,
        functionName: 'setSale',
        args: [
          newTokenId,
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
      args: [newTokenId, strategy, saleData],
    }),
  )

  // 5. (Optional) route secondary royalties + the creator-reward recipient to a
  //    split, so getCreatorRewardRecipient resolves it (mainnet distribute
  //    depends on this; mirrors In Process's Base behavior).
  if (params.royaltyRecipient) {
    actions.push(
      encodeFunctionData({
        abi: COLLECTION_ABI,
        functionName: 'updateRoyaltiesForToken',
        args: [
          newTokenId,
          {
            royaltyMintSchedule: 0,
            royaltyBPS: params.royaltyBps ?? 0,
            royaltyRecipient: params.royaltyRecipient,
          },
        ],
      }),
    )
  }

  // 6. (Optional) admin-mint copies to the creator.
  if (mintCount > 0) {
    actions.push(
      encodeFunctionData({
        abi: COLLECTION_ABI,
        functionName: 'adminMint',
        args: [params.creator, newTokenId, BigInt(mintCount), '0x' as `0x${string}`],
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
