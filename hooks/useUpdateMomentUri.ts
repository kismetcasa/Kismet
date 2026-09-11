'use client'

import { usePublicClient, useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import type { Address, Hash } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import { isMetadataUri } from '@/lib/momentUriEdit'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'

export interface UpdateMomentUriRequest {
  collection: Address
  tokenId: bigint
  /** Freshly-uploaded metadata pointer (ar://…). Becomes uri(tokenId) on-chain. */
  newUri: string
  /** Fires once the wallet prompt clears, before the receipt — flip toast copy. */
  onTxSubmitted?: () => void
}

/**
 * Direct, artist-signed `updateTokenURI` on a Zora 1155 artwork — the
 * token-level twin of useUpdateCollectionMetadata and the metadata sibling of
 * useUpdateMomentSale. The connected wallet must clear the contract's
 * onlyAdminOrRole(tokenId, METADATA) gate (ADMIN or METADATA, token-level or
 * collection-wide), which is exactly what useMomentEditPermission reads to
 * show the pencil — so the affordance and the write can't disagree.
 *
 * Direct (not inprocess-relayed) on purpose: lib/momentUriEdit.ts carries the
 * incident record. Waits for the receipt and checks `status` (a reverted call
 * still yields a receipt) before reporting success, so callers can treat the
 * return as final on-chain truth.
 */
export function useUpdateMomentUri() {
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  async function update({
    collection,
    tokenId,
    newUri,
    onTxSubmitted,
  }: UpdateMomentUriRequest): Promise<{ hash: Hash }> {
    if (!publicClient) throw new Error('No network client available')
    // Enforced before the wallet prompt (the retired server route's check),
    // so a data:/blob: pointer can never be committed on-chain.
    if (!isMetadataUri(newUri)) throw new Error('Metadata URI must be ar:// or https://')
    await ensureBase()
    const hash = await writeContractAsync({
      chainId: base.id,
      address: collection,
      abi: COLLECTION_ABI,
      functionName: 'updateTokenURI',
      args: [tokenId, newUri],
      dataSuffix: BUILDER_DATA_SUFFIX,
    })
    onTxSubmitted?.()
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('Metadata update reverted on-chain')
    return { hash }
  }

  return { update }
}
