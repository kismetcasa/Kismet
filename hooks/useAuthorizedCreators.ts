'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
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
 * Reads every address with ADMIN on the collection, hydrated with
 * KV-stored EOA / label mappings where available. Cross-checks each
 * entry against on-chain perms so rows revoked outside the panel
 * render as stale. Pass `deployer` (the displayed creator's EOA) so
 * the server can exclude the artist's smart wallet + OPERATOR_SMART_WALLET
 * from the chain merge — both are granted ADMIN at deploy and would
 * otherwise pollute the list.
 */
export function useAuthorizedCreators(
  collection: Address | undefined,
  deployer: Address | undefined,
) {
  const publicClient = usePublicClient({ chainId: base.id })
  const [creators, setCreators] = useState<AuthorizedCreatorEntry[]>([])
  const [loading, setLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!collection) {
      setCreators([])
      return
    }
    setLoading(true)
    try {
      const url = deployer
        ? `/api/collection/authorized-creators?collection=${collection}&deployer=${deployer}`
        : `/api/collection/authorized-creators?collection=${collection}`
      const res = await fetch(url)
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
  }, [collection, deployer, publicClient])

  useEffect(() => {
    void refetch()
  }, [refetch])

  return { creators, loading, refetch }
}
