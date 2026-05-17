'use client'

import { useAccount, useReadContracts } from 'wagmi'
import { type Address, isAddress } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit } from '@/lib/permissions'
import { useInprocessSmartWallet } from './useInprocessSmartWallet'

export interface CollectionPermStatus {
  /**
   * - `true`  → smart wallet has ADMIN; collection is mint-ready
   * - `false` → smart wallet read succeeded; ADMIN bit NOT set
   * - `null`  → still loading or read errored (treat as "unknown")
   */
  hasAdmin: boolean | null
}

export interface UseCollectionsPermissionsResult {
  /** Lookup keyed by lowercase address. */
  byAddress: Record<string, CollectionPermStatus>
  loading: boolean
  /** Number of collections with confirmed missing ADMIN. */
  missingCount: number
  /** Trigger a fresh chain read (e.g. after granting a permission). */
  refetch: () => void
}

/**
 * Resolves the connected user's inprocess smart wallet, then batch-reads
 * `permissions(0, smartWallet)` for every supplied collection. Powers
 * the legacy-collection-survival surfaces (mint picker badges, profile
 * banner, /permissions dashboard).
 *
 * Failed reads yield `hasAdmin: null` so RPC flake never surfaces as a
 * false-negative ⚠️ badge.
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
    // Defend against ABI drift / proxy upgrades that could surface as
    // a non-bigint result and silently coerce to false through the
    // bitwise check.
    const raw = result.result
    if (typeof raw !== 'bigint') {
      console.warn(
        '[useCollectionsPermissions] non-bigint result; treating as unknown',
        { collection: addr, type: typeof raw },
      )
      byAddress[addr] = { hasAdmin: null }
      continue
    }
    const hasAdmin = hasAdminBit(raw)
    byAddress[addr] = { hasAdmin }
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
