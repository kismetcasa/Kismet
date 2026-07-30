'use client'

import { useAccount, useReadContracts } from 'wagmi'
import { type Address, isAddress } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import { canEditMomentMetadata, canEditMomentSale } from '@/lib/permissions'

/**
 * Shared on-chain permission probe for the edit affordances: reads
 * `permissions(tokenId, caller)` AND `permissions(0, caller)` (the row a
 * collection defaultAdmin / authorized-creator holds) in one batched call and
 * feeds both rows through `predicate`, ORing them the same way Zora's
 * `_hasAnyPermission` does — so an affordance shows for EVERY address the
 * on-chain gate will actually authorize, not just the resolved creator.
 *
 * Why an on-chain read (not inprocess `momentAdmins`): that list is
 * indexer-derived and carries smart-wallet addresses, while the edit writes
 * are signed by — and authorized against — the connected EOA. Reading the
 * same `permissions(tokenId, caller)` the contract reads is the only source
 * that can't disagree with the authorization gate.
 *
 * Pass `skip` (e.g. the caller is already the resolved creator, whose
 * affordance shows regardless) to avoid the multicall entirely — co-admin
 * detection then costs one batched read only for non-creator viewers.
 */
function useMomentPermission(
  collection: string,
  tokenId: string,
  predicate: (perms: bigint) => boolean,
  options: { skip?: boolean } = {},
): boolean {
  const { address: eoa } = useAccount()
  const caller = eoa && isAddress(eoa) ? (eoa as Address) : null
  // Guard BigInt() — a non-numeric tokenId would throw during render.
  const tokenIdBig = /^\d+$/.test(tokenId) ? BigInt(tokenId) : null

  const enabled =
    !options.skip && !!caller && isAddress(collection) && tokenIdBig !== null

  const { data } = useReadContracts({
    contracts: [
      {
        address: collection as Address,
        abi: COLLECTION_ABI,
        functionName: 'permissions' as const,
        args: caller && tokenIdBig !== null ? ([tokenIdBig, caller] as const) : undefined,
      },
      {
        address: collection as Address,
        abi: COLLECTION_ABI,
        functionName: 'permissions' as const,
        args: caller ? ([0n, caller] as const) : undefined,
      },
    ],
    query: { enabled },
  })

  if (!data) return false
  // A non-bigint result (ABI drift / proxy upgrade) is treated as "no
  // permission" rather than coerced through the bitwise check — mirrors
  // useCollectionsPermissions' defensive read.
  return data.some(
    (r) =>
      r.status === 'success' &&
      typeof r.result === 'bigint' &&
      predicate(r.result),
  )
}

/**
 * Client mirror of `canUpdateUri`: true when the connected EOA is allowed to
 * edit this moment's metadata — i.e. it holds ADMIN (2) or METADATA (16) on
 * the token, OR collection-wide (tokenId 0). Uses the shared
 * canEditMomentMetadata predicate so the affordance can't drift from the
 * update-uri backend's 403 gate.
 */
export function useMomentEditPermission(
  collection: string,
  tokenId: string,
  options: { skip?: boolean } = {},
): boolean {
  return useMomentPermission(collection, tokenId, canEditMomentMetadata, options)
}

/**
 * Sale-config twin of useMomentEditPermission: true when the connected EOA
 * clears the gate Zora's `callSale` enforces on-chain — ADMIN (2) or SALES
 * (8) on the token, OR collection-wide. NOT the metadata mask: a
 * METADATA-only co-admin must not see sale controls (their callSale would
 * revert), and a SALES-only holder gets sale controls but no pencil.
 */
export function useMomentSaleEditPermission(
  collection: string,
  tokenId: string,
  options: { skip?: boolean } = {},
): boolean {
  return useMomentPermission(collection, tokenId, canEditMomentSale, options)
}
