'use client'

import { useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { encodeFunctionData } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import { ZORA_MULTICALL_ABI } from '@/lib/zoraMint'
import { useEnsureBase } from '@/lib/useEnsureBase'

export interface AirdropRequest {
  collectionAddress: `0x${string}`
  tokenId: bigint
  recipients: `0x${string}`[]
}

/**
 * Submits an airdrop directly on chain via Zora 1155's `adminMint`,
 * bypassing inprocess's relay entirely. Caller's EOA must hold ADMIN
 * on either tokenId 0 (defaultAdmin from deploy) or the specific
 * tokenId (per-token grant — that's how the AirdropForm picker filters
 * its options, so this is structurally guaranteed for any moment the
 * user can select). Zora's `_hasAnyPermission` ORs the two rows so a
 * single ADMIN at either scope is sufficient.
 *
 * Why client-side: previous iterations tried to route airdrop through
 * inprocess's `/moment/airdrop` relay under our shared INPROCESS_API_KEY.
 * That path empirically rejects with "admin permission" regardless of
 * which wallet we grant ADMIN to (artist's smart wallet, operator
 * smart wallet, both — verified via the diagnostic round-trip with
 * inprocessMomentAdmins). Bypassing the relay removes the routing
 * ambiguity entirely; the user signs the tx with the wallet that
 * already has authority, no smart-wallet derivation in between.
 *
 * Cost: gas now lands on the user instead of inprocess's paymaster.
 * For Base mainnet, a single-recipient adminMint runs ~$0.001-0.01;
 * a 10-recipient multicall is roughly 5-10x. Acceptable trade for
 * unblocking the flow.
 *
 * Single recipient → direct `adminMint` call (no multicall overhead).
 * Multiple → batched via the OZ `multicall(bytes[])` entry every Zora
 * 1155 collection inherits. Reverts atomically on any sub-call
 * failure, so callers should pre-validate recipients (the form's
 * isAddress check covers the common typo case).
 *
 * Returns the tx hash. The caller is responsible for waiting on the
 * receipt before considering the airdrop complete; the form already
 * surfaces a basescan link so manual verification is one click away.
 */
export function useAirdrop() {
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  async function airdrop({
    collectionAddress,
    tokenId,
    recipients,
  }: AirdropRequest): Promise<`0x${string}`> {
    if (recipients.length === 0) throw new Error('No recipients')
    await ensureBase()

    if (recipients.length === 1) {
      return await writeContractAsync({
        chainId: base.id,
        address: collectionAddress,
        abi: COLLECTION_ABI,
        functionName: 'adminMint',
        args: [recipients[0], tokenId, 1n, '0x'],
      })
    }

    // Encode each adminMint as bytes and batch through the inherited
    // multicall entry on the 1155. The collection's `multicall(bytes[])`
    // signature is in ZORA_MULTICALL_ABI; the per-call adminMint
    // signature comes from COLLECTION_ABI.
    const calls = recipients.map((to) =>
      encodeFunctionData({
        abi: COLLECTION_ABI,
        functionName: 'adminMint',
        args: [to, tokenId, 1n, '0x'],
      }),
    )
    return await writeContractAsync({
      chainId: base.id,
      address: collectionAddress,
      abi: ZORA_MULTICALL_ABI,
      functionName: 'multicall',
      args: [calls],
    })
  }

  return { airdrop }
}
