'use client'

import { useConfig, useWriteContract } from 'wagmi'
import { getPublicClient } from '@wagmi/core'
import { COLLECTION_ABI, buildMomentMintActions } from '@/lib/collections'
import { ZORA_MULTICALL_ABI } from '@/lib/zoraMint'
import { BASE_CHAIN_ID } from '@/lib/chains'
import { useEnsureChain } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'

// Open sale window sentinel — max uint64, matching what In Process's SDK writes
// on setupNewToken for open editions (see OPEN_EDITION_MINT_SIZE in zoraMint).
const OPEN_SALE_END = 18446744073709551615n

export interface ClientMintRequest {
  collectionAddress: `0x${string}`
  /** ar:// or ipfs:// (or https) token metadata URI, already uploaded. */
  tokenURI: string
  /** ETH price per token, in wei. 0 = free mint. */
  priceWei: bigint
  /** Sale window. Defaults: start = now, end = open (max uint64). */
  saleStartSec?: bigint
  saleEndSec?: bigint
  /** Max editions. Defaults to open edition. */
  maxSupply?: bigint
  /** Copies admin-minted to the creator at create time. Defaults to 1. */
  mintToCreatorCount?: number
  /** Sale-proceeds recipient — the creator EOA, or a split contract. */
  fundsRecipient: `0x${string}`
  /** createReferral attribution (pass CREATE_REFERRAL). */
  createReferral: `0x${string}`
  /** Recipient of the creator copies (typically the creator EOA). */
  creator: `0x${string}`
  /** Chain the collection lives on. Defaults to Base. */
  chainId?: number
}

/**
 * Client-side, user-paid mint of a NEW token on an EXISTING In Process / Zora
 * 1155 collection. The user's wallet submits a single `multicall(bytes[])` —
 * setupNewToken → grant MINTER to the FixedPrice strategy → setSale →
 * adminMint copies to the creator — paying their own gas.
 *
 * This is the un-sponsored analog of the `/api/mint` relay (which mints via
 * In Process's paymaster on Base). It exists because In Process's relay is
 * Base-only, so mainnet has to mint directly on-chain
 * (MAINNET_EXPANSION_SCOPE.md §6.1, Phase 4 Option B). Nothing wires this in
 * yet — Base mints still go through the sponsored relay; this is the building
 * block the mainnet path (and a future MintForm chain selector) will call when
 * `getChain(chainId).sponsoredMint === false`.
 *
 * Mirrors hooks/useAirdrop.ts: same client-side `multicall` on the collection,
 * same builder-code attribution, same `ensureChain`. `chainId` defaults to
 * Base. ETH (FixedPrice) only for now; USDC (ERC20Minter.setSale) is a
 * follow-up.
 *
 * Requires the connected EOA to hold collection-wide ADMIN — setupNewToken
 * reverts otherwise. A self-deployed collection grants its deployer ADMIN
 * (defaultAdmin), so this holds for a creator minting into their own
 * collection. Returns the tx hash and the new token id; the caller waits on
 * the receipt before treating the mint as complete.
 */
export function useClientMint() {
  const config = useConfig()
  const { writeContractAsync } = useWriteContract()
  const ensureChain = useEnsureChain()

  async function mint(req: ClientMintRequest): Promise<{ hash: `0x${string}`; tokenId: bigint }> {
    const {
      collectionAddress,
      tokenURI,
      priceWei,
      saleStartSec,
      saleEndSec,
      maxSupply,
      mintToCreatorCount,
      fundsRecipient,
      createReferral,
      creator,
      chainId = BASE_CHAIN_ID,
    } = req

    await ensureChain(chainId)

    // Public client for the target chain (wagmi configures both Base + mainnet
    // — see lib/wagmi.ts), resolved per-call so the same hook serves either.
    const publicClient = getPublicClient(config, { chainId })
    if (!publicClient) throw new Error(`No RPC client configured for chain ${chainId}`)

    // The id setupNewToken will assign = the collection's current nextTokenId.
    // Read it now; buildMomentMintActions guards the batch with
    // assumeLastTokenIdMatches(nextTokenId - 1) so a concurrent create can't
    // shift the id and mis-target our setSale/adminMint.
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
      pricePerTokenWei: priceWei,
      saleStart: saleStartSec ?? now,
      saleEnd: saleEndSec ?? OPEN_SALE_END,
      fundsRecipient,
      creator,
      mintToCreatorCount,
      newTokenId,
      chainId,
    })

    const hash = await writeContractAsync({
      chainId,
      address: collectionAddress,
      abi: ZORA_MULTICALL_ABI,
      functionName: 'multicall',
      args: [actions],
      dataSuffix: BUILDER_DATA_SUFFIX,
    })

    return { hash, tokenId: newTokenId }
  }

  return { mint }
}
