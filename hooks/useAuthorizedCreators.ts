'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { BASE_CHAIN_ID } from '@/lib/chains'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit } from '@/lib/permissions'

export interface AuthorizedCreatorEntry {
  /** Undefined for chain-only entries (off-platform addPermission, no
   *  KV reverse-lookup). UI renders those as "(unmapped)". */
  eoa: string | undefined
  smartWallet: string
  label?: string
  grantedBy: string
  grantedAt: number
  /** True iff the smart wallet still holds ADMIN on chain. The merged
   *  GET response includes both KV-stored and chain-discovered entries;
   *  this flag lets the UI grey out KV rows whose grant was revoked
   *  outside the panel (etherscan etc.). */
  liveOnChain: boolean
}

/**
 * Reads the EOA → smart-wallet mappings the admin recorded when
 * authorizing creators on this collection. Cross-checks each entry
 * against on-chain perms so a row revoked outside our UI renders as
 * stale instead of as a live authorization.
 */
export function useAuthorizedCreators(collection: Address | undefined, chainId: number = BASE_CHAIN_ID) {
  const publicClient = usePublicClient({ chainId })
  const [creators, setCreators] = useState<AuthorizedCreatorEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!collection) {
      setCreators([])
      return
    }
    setLoading(true)
    try {
      const res = await fetch(
        `/api/collection/authorized-creators?collection=${collection}`,
      )
      if (!res.ok) {
        setCreators([])
        return
      }
      const data = (await res.json()) as {
        creators?: Omit<AuthorizedCreatorEntry, 'liveOnChain'>[]
      }
      const stored = Array.isArray(data.creators) ? data.creators : []
      if (stored.length === 0 || !publicClient) {
        setCreators(stored.map((c) => ({ ...c, liveOnChain: !publicClient })))
        return
      }
      const checks = await Promise.all(
        stored.map(async (c) => {
          try {
            const perms = (await publicClient.readContract({
              address: collection,
              abi: COLLECTION_ABI,
              functionName: 'permissions',
              args: [0n, c.smartWallet as `0x${string}`],
            })) as bigint
            return { ...c, liveOnChain: hasAdminBit(perms) }
          } catch {
            // Read failed (RPC blip): assume live to avoid false-stale flicker.
            return { ...c, liveOnChain: true }
          }
        }),
      )
      setCreators(checks)
    } catch {
      setCreators([])
    } finally {
      setLoading(false)
    }
  }, [collection, publicClient])

  useEffect(() => {
    void refetch()
  }, [refetch])

  return { creators, loading, refetch }
}
