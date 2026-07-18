'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { PaginatedGrid } from './PaginatedGrid'
import { MomentOval, ListingOval } from './MarketOvals'
import type { Moment } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'

type Market = 'primary' | 'secondary'

interface PlatformStats {
  mints: number | null
  earningsUsd: number | null
  resaleUsd: number | null
}

// 1 oval per row on mobile, 2 on tablet, 3 on desktop — the "2–3 per row"
// density. Ovals are wide, so this stays readable at every breakpoint.
const OVAL_GRID = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'

const fmtUsd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
    style: 'currency',
    currency: 'USD',
  }).format(n)

/**
 * Advanced market browser: every mint (Primary) or every live resale
 * (Secondary) as a chronological wall of ovals. Desktop auto-loads on scroll;
 * mobile / Mini App loads 20 per tap and lazy-mounts off-screen ovals. Primary
 * is the timeline's native newest-first-by-mint-time order (stable against
 * edits — the "true history" requirement); Secondary is newest listing first.
 */
export function DiscoverMarketView({ isMobile = false }: { isMobile?: boolean }) {
  const [market, setMarket] = useState<Market>('primary')
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const pageLimit = isMobile ? 20 : 24
  const infiniteScroll = !isMobile

  // Platform totals for the top-right readout. One cached request (the endpoint
  // is public + s-maxage=300), fetched once — market-independent, so switching
  // tabs never re-fetches.
  useEffect(() => {
    let cancelled = false
    fetch('/api/stats/platform')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        setStats({
          mints: typeof d?.catalog?.artworksMinted === 'number' ? d.catalog.artworksMinted : null,
          earningsUsd: typeof d?.earnings?.total?.usd === 'number' ? d.earnings.total.usd : null,
          resaleUsd: typeof d?.resales?.usd === 'number' ? d.resales.usd : null,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // Second line under "<market> market". Falls back to the ordering hint until
  // the totals land (or if a figure is unavailable).
  const statLine =
    market === 'primary'
      ? stats == null
        ? 'newest first'
        : [
            stats.mints != null ? `${stats.mints.toLocaleString()} mints` : null,
            stats.earningsUsd ? `${fmtUsd(stats.earningsUsd)} earned` : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'newest first'
      : stats?.resaleUsd
        ? `${fmtUsd(stats.resaleUsd)} in resales`
        : 'newest first'

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
    <div className="flex items-center justify-between gap-4">
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
      <div className="text-right leading-tight">
        <div className="font-mono text-[11px] uppercase tracking-widest text-faint">{market} market</div>
        <div className="mt-0.5 font-mono text-xs tabular-nums text-muted">{statLine}</div>
      </div>
    </div>
  )

  if (market === 'primary') {
    return (
      <PaginatedGrid<Moment>
        // Distinct key per market: <PaginatedGrid<Moment>> and
        // <PaginatedGrid<Listing>> are the SAME runtime component (generics
        // erase), so without a key React reuses one instance across the toggle
        // and its accumulated extraPages of the other type would render through
        // the wrong renderItem (a Listing reaching MomentOval → BigInt(undefined)
        // crash). The key forces a clean remount → fresh state on every switch.
        key="market-primary"
        apiUrl="/api/timeline?scope=standalone"
        itemsKey="moments"
        getKey={(m) => `${m.address}:${m.token_id}`}
        pageLimit={pageLimit}
        lazy={isMobile}
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
      key="market-secondary"
      apiUrl="/api/listings"
      itemsKey="listings"
      getKey={(l) => l.id}
      pageLimit={pageLimit}
      lazy={isMobile}
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
