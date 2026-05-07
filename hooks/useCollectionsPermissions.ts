'use client'

import { useAccount, useReadContracts } from 'wagmi'
import { type Address, isAddress } from 'viem'
import { COLLECTION_ABI, PERMISSION_BIT_ADMIN } from '@/lib/collections'
import { useInprocessSmartWallet } from './useInprocessSmartWallet'

export interface CollectionPermStatus {
  /**
   * - `true`  → smart wallet has ADMIN bit set; collection is mint-ready
   * - `false` → smart wallet read succeeded; ADMIN bit NOT set; needs authorize
   * - `null`  → still loading, smart wallet not yet resolved, or read errored
   *   (treat as "unknown" — don't surface a false-negative warning)
   */
  hasAdmin: boolean | null
  /** Raw bitmap from the on-chain read; undefined if read didn't succeed. */
  perms?: bigint
}

export interface UseCollectionsPermissionsResult {
  /**
   * Lookup keyed by lowercase address. Missing entry = address wasn't
   * in the input list (or was filtered as malformed). Use the helper
   * `addr.toLowerCase()` to read.
   */
  byAddress: Record<string, CollectionPermStatus>
  /** True while the batch read is in flight or smart wallet is resolving. */
  loading: boolean
  /** Number of collections with confirmed missing ADMIN. Useful for badge counts. */
  missingCount: number
  /** Trigger a fresh chain read (e.g. after the user authorizes a collection). */
  refetch: () => void
}

/**
 * Phase 3 — resolves the connected user's inprocess smart wallet, then
 * batch-reads permissions(0, smartWallet) for every collection in the
 * provided list. Surfaces which existing collections need a retroactive
 * Authorize click before they can mint via the inprocess relay (the
 * "ensure already-created collections survive" requirement).
 *
 * Implementation notes:
 *   - Uses wagmi's useReadContracts (plural). Under the hood viem will
 *     batch via Multicall when supported, so a user with N collections
 *     pays roughly the cost of one RPC round-trip (Base supports
 *     multicall3 by default).
 *   - Reads the connected EOA via useAccount, resolves it through
 *     useInprocessSmartWallet (cached + deduped per EOA across the
 *     app so adjacent surfaces don't double-fetch).
 *   - Failed reads (RPC blip, contract not deployed yet, etc.) yield
 *     hasAdmin=null so callers can render an "unknown" state instead of
 *     a false-negative warning. RPC flake should never look like
 *     missing permissions.
 *   - The query is gated on having BOTH a smart wallet AND a non-empty
 *     valid address list. Without those, returns an empty map and
 *     loading=false (idle state).
 *
 * Caller pattern (e.g. MintForm picker dropdown):
 *
 *   const { byAddress, missingCount } = useCollectionsPermissions(
 *     userCollections.map((c) => c.address),
 *   )
 *   const status = byAddress[c.address.toLowerCase()]
 *   if (status?.hasAdmin === false) showWarningBadge()
 */
export function useCollectionsPermissions(
  addresses: string[],
): UseCollectionsPermissionsResult {
  const { address: eoa } = useAccount()
  const { address: smartWallet } = useInprocessSmartWallet(eoa)
  const validAddresses = addresses.filter((a) => isAddress(a))
  const sw =
    smartWallet && isAddress(smartWallet) ? (smartWallet as Address) : null

  const { data, isLoading, refetch } = useReadContracts({
    contracts: validAddresses.map((addr) => ({
      address: addr as Address,
      abi: COLLECTION_ABI,
      functionName: 'permissions' as const,
      args: sw ? ([0n, sw] as const) : undefined,
    })),
    query: {
      enabled: !!sw && validAddresses.length > 0,
    },
  })

  const byAddress: Record<string, CollectionPermStatus> = {}
  let missingCount = 0
  for (let i = 0; i < validAddresses.length; i++) {
    const addr = validAddresses[i].toLowerCase()
    const result = data?.[i]
    if (!result || result.status !== 'success') {
      byAddress[addr] = { hasAdmin: null }
      continue
    }
    const perms = result.result as bigint
    const hasAdmin = (perms & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
    byAddress[addr] = { hasAdmin, perms }
    if (!hasAdmin) missingCount += 1
  }

  return {
    byAddress,
    loading: isLoading,
    missingCount,
    refetch: () => {
      void refetch()
    },
  }
}
