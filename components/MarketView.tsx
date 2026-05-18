'use client'

import Link from 'next/link'
import { useAccount } from 'wagmi'
import { MarketCard } from '@/components/MarketCard'
import { PaginatedGrid } from '@/components/PaginatedGrid'
import type { Listing } from '@/lib/listings'

export function MarketView() {
  const { address } = useAccount()
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <PaginatedGrid<Listing>
        apiUrl="/api/listings"
        itemsKey="listings"
        getKey={(l) => l.id}
        renderItem={(l, helpers) => (
          <MarketCard key={l.id} listing={l} onRemove={helpers.remove} />
        )}
        header={
          <div>
            <h1 className="text-xs font-mono text-dim uppercase tracking-widest">Market</h1>
            <p className="text-xs font-mono text-faint mt-1">
              creator royalties enforced on every sale
            </p>
          </div>
        }
        empty={
          <div className="border border-line p-8 sm:p-16 text-center">
            <p className="text-sm font-mono text-muted">no listings yet</p>
            <p className="text-xs font-mono text-faint mt-2">
              collect a moment on{' '}
              <Link href="/" className="accent-grad hover:underline">enjoy</Link>
              {' '}then{' '}
              <Link href={address ? `/profile/${address}` : '/'} className="accent-grad hover:underline">list</Link>
              {' '}it here
            </p>
          </div>
        }
      />
    </div>
  )
}
