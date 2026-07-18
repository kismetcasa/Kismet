'use client'

import { useState } from 'react'
import Link from 'next/link'
import { PaginatedGrid } from './PaginatedGrid'
import { MomentOval, ListingOval } from './MarketOvals'
import type { Moment } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'

type Market = 'primary' | 'secondary'

// 1 oval per row on mobile, 2 on tablet, 3 on desktop — the "2–3 per row"
// density. Ovals are wide, so this stays readable at every breakpoint.
const OVAL_GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'

/**
 * Advanced market browser: every mint (Primary) or every live resale
 * (Secondary) as a chronological wall of ovals. Desktop auto-loads on scroll;
 * mobile / Mini App loads 20 per tap. Primary is the timeline's native
 * newest-first-by-mint-time order (stable against edits — the "true history"
 * requirement); Secondary is newest listing first.
 */
export function DiscoverMarketView({ isMobile = false }: { isMobile?: boolean }) {
  const [market, setMarket] = useState<Market>('primary')
  const pageLimit = isMobile ? 20 : 24
  const infiniteScroll = !isMobile

  // Oval-shaped cold-load placeholder, so the skeleton matches the row height
  // instead of flashing tall square cards before the ovals resolve.
  const skeleton = (
    <div className={OVAL_GRID}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-full border border-line bg-[#151515]" />
      ))}
    </div>
  )

  const header = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="inline-flex rounded-full border border-accent/40 bg-[#141414] p-0.5">
        {(['primary', 'secondary'] as Market[]).map((m) => (
          <button
            key={m}
            aria-pressed={market === m}
            onClick={() => setMarket(m)}
            className={`rounded-full px-4 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors ${
              market === m ? 'bg-accent font-semibold text-[#0d0d0d]' : 'text-muted hover:text-dim'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <span className="font-mono text-[11px] uppercase tracking-widest text-faint">
        {market === 'primary' ? 'every mint · newest first' : 'live resales · newest first'}
      </span>
    </div>
  )

  if (market === 'primary') {
    return (
      <PaginatedGrid<Moment>
        apiUrl="/api/timeline?scope=standalone"
        itemsKey="moments"
        getKey={(m) => `${m.address}:${m.token_id}`}
        pageLimit={pageLimit}
        infiniteScroll={infiniteScroll}
        containerClassName={OVAL_GRID}
        skeleton={skeleton}
        header={header}
        renderItem={(m) => <MomentOval key={`${m.address}:${m.token_id}`} moment={m} />}
        empty={
          <div className="border border-line p-8 text-center sm:p-16">
            <p className="font-mono text-sm text-muted">no mints yet</p>
          </div>
        }
      />
    )
  }

  return (
    <PaginatedGrid<Listing>
      apiUrl="/api/listings"
      itemsKey="listings"
      getKey={(l) => l.id}
      pageLimit={pageLimit}
      infiniteScroll={infiniteScroll}
      containerClassName={OVAL_GRID}
      skeleton={skeleton}
      header={header}
      renderItem={(l, { remove }) => <ListingOval key={l.id} listing={l} onRemove={remove} />}
      empty={
        <div className="border border-line p-8 text-center sm:p-16">
          <p className="font-mono text-sm text-muted">no live resales</p>
          <p className="mt-2 font-mono text-xs text-faint">
            collect on{' '}
            <Link href="/" className="accent-grad hover:underline">
              enjoy
            </Link>
            , then list it on your profile
          </p>
        </div>
      }
    />
  )
}
