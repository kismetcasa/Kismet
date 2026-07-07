'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Lists the wallets a collection admin has delegated airdrop rights to for a
 * single moment. Source of truth for the "who can airdrop this piece" panel
 * in AirdropForm. KV-backed (see /api/moment/airdrop-delegates); the on-chain
 * MINTER grant is what actually lets the delegate airdrop, this is just the
 * discovery/management record.
 */
export function useAirdropDelegates(
  collection: string | undefined,
  tokenId: string | undefined,
) {
  const [delegates, setDelegates] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!collection || tokenId == null) {
      setDelegates([])
      return
    }
    setLoading(true)
    try {
      const res = await fetch(
        `/api/moment/airdrop-delegates?collection=${collection}&tokenId=${tokenId}`,
        { credentials: 'same-origin' },
      )
      if (!res.ok) {
        setDelegates([])
        return
      }
      const data = (await res.json()) as { delegates?: string[] }
      setDelegates(Array.isArray(data.delegates) ? data.delegates : [])
    } catch {
      setDelegates([])
    } finally {
      setLoading(false)
    }
  }, [collection, tokenId])

  useEffect(() => {
    void refetch()
  }, [refetch])

  return { delegates, loading, refetch }
}
