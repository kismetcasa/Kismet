'use client'

import { useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { COLLECTION_ABI } from '@/lib/collections'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'

export interface UpdateCollectionMetadataRequest {
  collection: `0x${string}`
  /** Freshly-uploaded contractURI (ar://…). Becomes uri(0) on-chain. */
  newUri: string
  /** Display name — written to the on-chain name() AND mirrored into the
   *  uploaded JSON's `name` so the two never diverge. */
  newName: string
}

/**
 * Direct, user-signed `updateContractMetadata` on a Zora 1155 collection —
 * the contract-level twin of the airdrop/authorize writes (useAirdrop,
 * useGrantPermission). The connected wallet is the deployer/defaultAdmin
 * (the UI gates this on `isCreator`), so it satisfies the contract's
 * `onlyAdminOrRole(0, METADATA)` gate without a preflight.
 *
 * Direct (not inprocess-relayed) because contract-level metadata is an
 * admin-class write: the relay executes admin writes as the operator wallet
 * (perms=0), which empirically rejects them (see useAirdrop's migration off
 * the relay). The artist's own EOA holds ADMIN, so it just works — and lands
 * the artist (not the operator) as the on-chain updater.
 *
 * Returns the tx hash; the caller waits on the receipt (same contract as
 * useAirdrop) before treating the edit as committed.
 */
export function useUpdateCollectionMetadata() {
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  async function update({
    collection,
    newUri,
    newName,
  }: UpdateCollectionMetadataRequest): Promise<`0x${string}`> {
    await ensureBase()
    return writeContractAsync({
      chainId: base.id,
      address: collection,
      abi: COLLECTION_ABI,
      functionName: 'updateContractMetadata',
      args: [newUri, newName],
      dataSuffix: BUILDER_DATA_SUFFIX,
    })
  }

  return { update }
}
