'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit } from '@/lib/permissions'

export interface AuthorizedCreatorEntry {
  eoa: string
  smartWallet: string
  label?: string
  grantedBy: string
  grantedAt: number
  /** True iff the smart wallet still holds ADMIN on chain. KV is the
   *  reverse-lookup store for display; the chain is the source of truth
   *  for whether the grant is live. We surface this so a stale KV row
   *  (admin revoked via etherscan, never via our UI) renders as
   *  "revoked elsewhere" rather than as a live authorization. */
  liveOnChain: boolean
}

/**
 * Reads the {EOA, smartWallet, label} list an admin recorded when
 * authorizing creators on this collection (server-side KV), then
 * cross-checks each entry against on-chain permissions so a row that
 * was revoked outside our UI shows as stale.
 *
 * Why KV: inprocess's smart-wallet lookup is one-way (EOA → SW), so
 * given only the on-chain ADMIN row we couldn't recover the EOA the
 * admin originally typed (or the ENS label). We persist the mapping
 * at grant time and use the chain for liveness.
 */
export function useAuthorizedCreators(collection: Address | undefined) {
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
        // No public client: render with liveness=true so the list at
        // least shows; selecting an entry that's actually been revoked
        // off-platform will fail at the next chain-mediated step.
        setCreators(stored.map((c) => ({ ...c, liveOnChain: !publicClient })))
        return
      }
      // Batch-read each smart wallet's tokenId-0 perms; mark stale
      // entries so the UI can grey them out.
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
            // Read failed (RPC blip): assume live to avoid a
            // false-stale flicker.
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
