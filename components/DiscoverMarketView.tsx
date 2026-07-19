'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { PaginatedGrid } from './PaginatedGrid'
import { MomentOval, ListingOval } from './MarketOvals'
import {
  DiscoverPillBar,
  clearedFilters,
  discoverUrl,
  hasActiveFilters,
  parseDiscoverState,
  primaryApiUrl,
  secondaryApiUrl,
  type DiscoverState,
} from './DiscoverFilters'
import type { Moment } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'

interface PlatformStats {
  mints: number | null
  earningsUsd: number | null
  resaleUsd: number | null
  /** Chainlink ETH/USD from the same payload — powers the oval price tooltips. */
  ethUsd: number | null
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
 * (Secondary) as a chronological wall of ovals, with the filter state living
 * in the URL (shareable links, back-button coherent). Refinements rewrite the
 * URL via history.replaceState; market/sort changes push a history entry.
 * Desktop auto-loads on scroll; mobile / Mini App loads 20 per tap and
 * lazy-mounts off-screen ovals.
 */
export function DiscoverMarketView({
  isMobile = false,
  initialState,
}: {
  isMobile?: boolean
  initialState: DiscoverState
}) {
  const [state, setState] = useState<DiscoverState>(initialState)
  const [stats, setStats] = useState<PlatformStats | null>(null)
  const pageLimit = isMobile ? 20 : 24
  const infiniteScroll = !isMobile

  // All state changes flow through here so the URL and component state can
  // never disagree. push=true for navigation-grade changes (market, sort);
  // refinements replace so pill-tapping doesn't pollute history.
  const update = useCallback((patch: Partial<DiscoverState>, opts?: { push?: boolean }) => {
    setState((prev) => {
      const next = { ...prev, ...patch }
      const url = discoverUrl(next)
      try {
        if (opts?.push) window.history.pushState(null, '', url)
        else window.history.replaceState(null, '', url)
      } catch {}
      return next
    })
  }, [])

  // Back/forward restores the full filter state from the URL.
  useEffect(() => {
    const onPop = () => {
      const params = new URLSearchParams(window.location.search)
      setState(parseDiscoverState((k) => params.get(k)))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

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
          ethUsd: typeof d?.earnings?.ethUsd === 'number' ? d.earnings.ethUsd : null,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const market = state.market
  const filtered = hasActiveFilters(state)

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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="inline-flex rounded-full border border-accent/40 bg-[#141414] p-0.5">
          {(['primary', 'secondary'] as const).map((m) => (
            <button
              key={m}
              aria-pressed={market === m}
              onClick={() => update({ market: m }, { push: true })}
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
      <DiscoverPillBar
        state={state}
        onChange={(patch) => update(patch)}
        onSortChange={(patch) => update(patch, { push: true })}
      />
    </div>
  )

  // With filters active, an empty page means "no matches", never "no activity"
  // — and always offers the way out.
  const filteredEmpty = (
    <div className="border border-line p-8 text-center sm:p-16">
      <p className="font-mono text-sm text-muted">no matches for these filters</p>
      <button
        onClick={() => update(clearedFilters(state))}
        className="mt-3 rounded-full border border-line px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-dim hover:border-accent hover:text-accent"
      >
        clear filters
      </button>
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
        apiUrl={primaryApiUrl(state)}
        itemsKey="moments"
        getKey={(m) => `${m.address}:${m.token_id}`}
        pageLimit={pageLimit}
        lazy={isMobile}
        infiniteScroll={infiniteScroll}
        containerClassName={OVAL_GRID}
        skeleton={skeleton}
        header={header}
        renderItem={(m) => <MomentOval key={`${m.address}:${m.token_id}`} moment={m} ethUsd={stats?.ethUsd} />}
        empty={
          filtered ? (
            filteredEmpty
          ) : (
            <div className="border border-line p-8 text-center sm:p-16">
              <p className="font-mono text-sm text-muted">no mints yet</p>
            </div>
          )
        }
      />
    )
  }

  return (
    <PaginatedGrid<Listing>
      key="market-secondary"
      apiUrl={secondaryApiUrl(state)}
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
        filtered ? (
          filteredEmpty
        ) : (
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
        )
      }
    />
  )
}
