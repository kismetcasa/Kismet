'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { useAccount } from 'wagmi'
import { MarketCard } from '@/components/MarketCard'
import type { Listing } from '@/lib/listings'

export function MarketView() {
  const [listings, setListings] = useState<Listing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const { address } = useAccount()

  const fetchListings = useCallback(async (p = 1, append = false) => {
    try {
      if (p === 1 && !append) setLoading(true)
      else setRefreshing(true)

      const params = new URLSearchParams({ page: String(p), limit: '18' })
      const res = await fetch(`/api/listings?${params}`)
      if (!res.ok) throw new Error(`Failed to load market (${res.status})`)
      const data = await res.json()

      setListings((prev) => append ? [...prev, ...data.listings] : data.listings)
      setTotalPages(data.pagination?.total_pages ?? 1)
      setPage(p)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load market')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchListings(1) }, [fetchListings])

  function removeListing(id: string) {
    setListings((prev) => prev.filter((l) => l.id !== id))
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-xs font-mono text-[#888] uppercase tracking-widest">Market</h1>
          <p className="text-xs font-mono text-[#333] mt-1">
            creator royalties enforced on every sale
          </p>
        </div>
        <button
          onClick={() => fetchListings(1)}
          disabled={loading || refreshing}
          className="flex items-center gap-2 text-xs font-mono text-[#555] hover:text-[#888] transition-colors disabled:opacity-40"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          refresh
        </button>
      </div>

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-[#161616] border border-[#2a2a2a]">
              <div className="aspect-square bg-[#1a1a1a] animate-pulse" />
              <div className="p-4 space-y-2">
                <div className="h-3 bg-[#1a1a1a] animate-pulse w-2/3" />
                <div className="h-3 bg-[#1a1a1a] animate-pulse w-1/3" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && !loading && (
        <div className="border border-red-900/50 p-6 text-center">
          <p className="text-sm font-mono text-red-400">{error}</p>
          <button
            onClick={() => fetchListings(1)}
            className="mt-4 text-xs font-mono text-[#888] hover:text-[#efefef] underline"
          >
            try again
          </button>
        </div>
      )}

      {!loading && !error && listings.length === 0 && (
        <div className="border border-[#2a2a2a] p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-[#555]">no listings yet</p>
          <p className="text-xs font-mono text-[#333] mt-2">
            collect a moment on{' '}
            <Link href="/" className="accent-grad hover:underline">discover</Link>
            {' '}then{' '}
            <Link href={address ? `/profile/${address}` : '/'} className="accent-grad hover:underline">list</Link>
            {' '}it here
          </p>
        </div>
      )}

      {!loading && listings.length > 0 && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {listings.map((listing) => (
              <MarketCard
                key={listing.id}
                listing={listing}
                onRemove={() => removeListing(listing.id)}
              />
            ))}
          </div>

          {page < totalPages && (
            <div className="mt-8 text-center">
              <button
                onClick={() => fetchListings(page + 1, true)}
                disabled={refreshing}
                className="px-8 py-3 border border-[#2a2a2a] text-xs font-mono text-[#888] uppercase tracking-wider hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
              >
                {refreshing ? 'loading…' : 'load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
