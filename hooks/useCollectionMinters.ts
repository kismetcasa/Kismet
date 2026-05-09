'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { PERMISSION_BIT_MINTER } from '@/lib/permissions'

/**
 * Reads the live set of addresses holding MINTER (collection-wide,
 * tokenId 0) on a Zora 1155 collection by scanning UpdatedPermissions
 * logs and replaying the latest event per user.
 *
 * Why logs instead of a view function: Zora's contract exposes only a
 * point lookup `permissions(tokenId, user)` — there is no "list users"
 * view. Every addPermission/removePermission emits the user's full new
 * bitmap, so the latest event per user is authoritative. We dedupe by
 * (blockNumber, logIndex) to handle reorgs deterministically.
 *
 * Per-token grants (tokenId > 0) are intentionally excluded — the
 * post-deploy panel only manages collection-wide grants, and the
 * FixedPriceStrategy auto-grant lives at tokenId >= 1.
 */
export function useCollectionMinters(collection: Address | undefined) {
  const publicClient = usePublicClient({ chainId: base.id })
  const [minters, setMinters] = useState<Address[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const refetch = useCallback(async () => {
    if (!collection || !publicClient) {
      setMinters([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const logs = await publicClient.getLogs({
        address: collection,
        event: {
          type: 'event',
          name: 'UpdatedPermissions',
          inputs: [
            { name: 'tokenId', type: 'uint256', indexed: true },
            { name: 'user', type: 'address', indexed: true },
            { name: 'permissions', type: 'uint256', indexed: true },
          ],
        },
        args: { tokenId: 0n },
        fromBlock: 'earliest',
        toBlock: 'latest',
      })
      // Sort ascending so the last write per user wins.
      logs.sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) {
          return Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n))
        }
        return (a.logIndex ?? 0) - (b.logIndex ?? 0)
      })
      const latest = new Map<string, bigint>()
      for (const log of logs) {
        const user = log.args.user as Address | undefined
        const perms = log.args.permissions as bigint | undefined
        if (!user || perms === undefined) continue
        latest.set(user.toLowerCase(), perms)
      }
      const out: Address[] = []
      for (const [user, perms] of latest.entries()) {
        if ((perms & PERMISSION_BIT_MINTER) === PERMISSION_BIT_MINTER) {
          out.push(user as Address)
        }
      }
      setMinters(out)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setMinters([])
    } finally {
      setLoading(false)
    }
  }, [collection, publicClient])

  useEffect(() => {
    void refetch()
  }, [refetch])

  return { minters, loading, error, refetch }
}
