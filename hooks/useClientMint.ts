'use client'

import { useConfig, useWriteContract } from 'wagmi'
import { getPublicClient } from '@wagmi/core'
import { zeroAddress, type Address } from 'viem'
import { COLLECTION_ABI, buildMomentMintActions } from '@/lib/collections'
import { ZORA_MULTICALL_ABI } from '@/lib/zoraMint'
import { BASE_CHAIN_ID } from '@/lib/chains'
import {
  SPLIT_MAIN_ABI,
  splitMainAddress,
  reconstructSplitParams,
  DISTRIBUTOR_FEE,
} from '@/lib/splitMain'
import { useEnsureChain } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import type { SplitRecipient } from '@/lib/splits'

// Open sale window sentinel — max uint64, matching what In Process's SDK writes
// on setupNewToken for open editions (see OPEN_EDITION_MINT_SIZE in zoraMint).
const OPEN_SALE_END = 18446744073709551615n

export interface ClientMintRequest {
  collectionAddress: `0x${string}`
  /** ar:// or ipfs:// (or https) token metadata URI, already uploaded. */
  tokenURI: string
  /** Price per token in base units — wei (ETH) or 6-decimal units (USDC). 0 = free. */
  price: bigint
  /** Sale currency. Defaults to ETH (FixedPriceSaleStrategy). */
  currency?: 'eth' | 'usdc'
  /** Sale window. Defaults: start = now, end = open (max uint64). */
  saleStartSec?: bigint
  saleEndSec?: bigint
  /** Max editions. Defaults to open edition. */
  maxSupply?: bigint
  /** Copies admin-minted to the creator at create time. Defaults to 1. */
  mintToCreatorCount?: number
  /** Recipient of the creator copies + default payout when there are no splits. */
  creator: `0x${string}`
  /** createReferral attribution (pass CREATE_REFERRAL). */
  createReferral: `0x${string}`
  /**
   * Sale-proceeds recipient when there are NO splits. Defaults to `creator`.
   * Ignored when `splits` is set (proceeds route to the created split).
   */
  payoutRecipient?: `0x${string}`
  /**
   * ≥2 recipients → create a 0xSplits split first and route sale proceeds AND
   * secondary royalties to it. <2 → no split (single payout recipient).
   */
  splits?: SplitRecipient[]
  /** Royalty BPS to write when routing royalties to a split. Defaults to 0. */
  royaltyBps?: number
  /** Chain the collection lives on. Defaults to Base. */
  chainId?: number
}

export interface ClientMintResult {
  /** The mint (multicall) transaction hash. */
  hash: `0x${string}`
  /** The new token's id. */
  tokenId: bigint
  /** The created split address, when `splits` was provided. */
  splitAddress?: Address
}

/**
 * Client-side, user-paid creation of a NEW moment on an EXISTING In Process /
 * Zora 1155 collection — the un-sponsored analog of `/api/mint`, for mainnet
 * (the In Process relay is Base-only; MAINNET_EXPANSION_SCOPE.md §12).
 *
 * Two on-chain steps when `splits` is set, otherwise one:
 *   1. (splits only) `SplitMain.createSplit(...)` from the user's wallet → the
 *      split address (immutable, so predicted before the tx and confirmed after).
 *   2. `multicall([assumeLastTokenId, setupNewToken, grant MINTER, setSale,
 *      (updateRoyalties→split), adminMint])` — paying their own gas.
 *
 * With splits, the split is wired as BOTH the sale `fundsRecipient` and the
 * per-token royalty recipient, so `getCreatorRewardRecipient` resolves it and
 * the user-paid distribute path (useMomentSplits) works — mirroring In Process
 * on Base.
 *
 * Requires the connected EOA to hold collection-wide ADMIN (a self-deployed
 * collection grants its deployer ADMIN). Handles ETH + USDC. Nothing wires this
 * in yet; the MintForm chain selector (§12.8) will, branching on
 * `getChain(chainId).sponsoredMint === false`. Defaults to Base so the hook is a
 * no-op for the current sponsored path.
 */
export function useClientMint() {
  const config = useConfig()
  const { writeContractAsync } = useWriteContract()
  const ensureChain = useEnsureChain()

  async function mint(req: ClientMintRequest): Promise<ClientMintResult> {
    const {
      collectionAddress,
      tokenURI,
      price,
      currency = 'eth',
      saleStartSec,
      saleEndSec,
      maxSupply,
      mintToCreatorCount,
      creator,
      createReferral,
      payoutRecipient,
      splits,
      royaltyBps,
      chainId = BASE_CHAIN_ID,
    } = req

    await ensureChain(chainId)

    // Public client for the target chain (wagmi configures both Base + mainnet),
    // resolved per-call so the same hook serves either.
    const publicClient = getPublicClient(config, { chainId })
    if (!publicClient) throw new Error(`No RPC client configured for chain ${chainId}`)

    // Step 1 (splits only): create the 0xSplits split, routing funds + royalties
    // to it. The immutable split address is deterministic, so predict it, create
    // it, and wait for confirmation before minting.
    let splitAddress: Address | undefined
    if (splits && splits.length >= 2) {
      const { accounts, percentAllocations } = reconstructSplitParams(splits)
      const splitMain = splitMainAddress(chainId)
      // Immutable splits are deterministic (CREATE2 over the params), so the
      // address is known up front — and re-creating an existing one reverts.
      // Predict it, then deploy only if it isn't there yet: this makes a retry
      // after a failed mint safe, and an identical recipient set simply reuses
      // its split (every recipient still gets their exact % of the pooled funds).
      splitAddress = await publicClient.readContract({
        address: splitMain,
        abi: SPLIT_MAIN_ABI,
        functionName: 'predictImmutableSplitAddress',
        args: [accounts, percentAllocations, DISTRIBUTOR_FEE],
      })
      const deployed = await publicClient.getCode({ address: splitAddress })
      if (!deployed || deployed === '0x') {
        const createHash = await writeContractAsync({
          chainId,
          address: splitMain,
          abi: SPLIT_MAIN_ABI,
          functionName: 'createSplit',
          args: [accounts, percentAllocations, DISTRIBUTOR_FEE, zeroAddress], // controller=0 → immutable
          dataSuffix: BUILDER_DATA_SUFFIX,
        })
        await publicClient.waitForTransactionReceipt({ hash: createHash })
      }
    }

    const fundsRecipient = splitAddress ?? payoutRecipient ?? creator

    // The id setupNewToken will assign = the collection's current nextTokenId.
    // buildMomentMintActions guards the batch with
    // assumeLastTokenIdMatches(nextTokenId - 1) against a concurrent create.
    const newTokenId = await publicClient.readContract({
      address: collectionAddress,
      abi: COLLECTION_ABI,
      functionName: 'nextTokenId',
    })

    const now = BigInt(Math.floor(Date.now() / 1000))
    const actions = buildMomentMintActions({
      tokenURI,
      maxSupply,
      createReferral,
      pricePerTokenWei: price,
      saleStart: saleStartSec ?? now,
      saleEnd: saleEndSec ?? OPEN_SALE_END,
      fundsRecipient,
      creator,
      mintToCreatorCount,
      newTokenId,
      chainId,
      currency,
      // Route royalties to the split only when there is one.
      ...(splitAddress ? { royaltyRecipient: splitAddress, royaltyBps } : {}),
    })

    const hash = await writeContractAsync({
      chainId,
      address: collectionAddress,
      abi: ZORA_MULTICALL_ABI,
      functionName: 'multicall',
      args: [actions],
      dataSuffix: BUILDER_DATA_SUFFIX,
    })

    return { hash, tokenId: newTokenId, splitAddress }
  }

  return { mint }
}
