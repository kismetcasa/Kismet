'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import Image from 'next/image'
import { X } from 'lucide-react'
import { PaginatedGrid } from './PaginatedGrid'
import { MomentOval, ListingOval } from './MarketOvals'
import { useWatchlist, type WatchlistEntry } from '@/hooks/useWatchlist'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { trackFunnel } from '@/lib/funnel'
import { DiscoverPillBar } from './DiscoverFilters'
import {
  clearedFilters,
  discoverUrl,
  hasActiveFilters,
  parseDiscoverState,
  primaryApiUrl,
  reconcileState,
  secondaryApiUrl,
  type DiscoverState,
} from '@/lib/discoverState'
import type { Moment } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'

interface PlatformStats {
  /** VISIBLE (non-hidden) artworks minted — hidden work is excluded so the
   *  public counter matches what the feeds actually show. */
  mints: number | null
  earningsUsd: number | null
  resaleUsd: number | null
  /** Chainlink ETH/USD from the same payload — powers the oval price tooltips. */
  ethUsd: number | null
  // Stats-modal figures, from the same single fetch (no extra request):
  /** All-time gross buyer volume, primary (art + passes) + secondary resales. */
  volumeUsd: number | null
  /** The same total denominated in ETH — the exact inverse of the API's usd
   *  derivation: ETH legs pass through unconverted, USDC legs divide by the
   *  same Chainlink price the USD figure multiplied with. Null when the
   *  conversion would be dishonest (price unavailable while a USDC leg > 0);
   *  a zero USDC leg needs no price at all, so pure-ETH volume never nulls. */
  volumeEth: number | null
  /** Distinct artists with at least one VISIBLE artwork — hidden-only makers
   *  excluded (catalog census visibleArtists). */
  artists: number | null
  /** Distinct paying art collectors (passes excluded, same scope as sales).
   *  A TRUE total by design: a sale happened whether or not the work is
   *  hidden today. */
  collectors: number | null
  /** Paid art editions sold (passes excluded — memberships aren't artworks). */
  editionsSold: number | null
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

// 3 significant digits keeps the ETH headline as compact as "$1.9K" across
// magnitudes (0.591 ETH · 12.3 ETH · 1,230 ETH).
const fmtEth = (n: number) =>
  `${new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 }).format(n)} ETH`

const LAST_VISIT_KEY = 'kismetart:discover-last-visit'
const PULSE_INTERVAL_MS = 60_000

/** Reconstruct a renderable Moment from a watchlist snapshot. Price, supply,
 *  and collectability still resolve live through the oval's own dwell-gated
 *  reads — only the display shell comes from the snapshot. */
function momentFromEntry(e: WatchlistEntry): Moment {
  return {
    address: e.address,
    token_id: e.tokenId,
    uri: '',
    creator: { address: e.creator ?? '', hidden: false },
    admins: [],
    // Guard addedAt: toISOString THROWS on an invalid date, and this runs per
    // entry per render — one legacy/corrupt row must not crash the page.
    created_at:
      e.createdAt ?? (Number.isFinite(e.addedAt) ? new Date(e.addedAt).toISOString() : ''),
    metadata: { name: e.name, image: e.image },
  }
}

/** The watchlist as its own view — never a feed filter (a client-side filter
 *  over server pages would produce lying sparse pages). Renders straight from
 *  the local snapshots: zero backend, instant, honest. */
function WatchlistView({
  ethUsd,
  resaleCounts,
}: {
  ethUsd?: number | null
  resaleCounts?: Map<string, number> | null
}) {
  const { entries } = useWatchlist()
  if (entries.length === 0) {
    return (
      <div className="border border-line p-8 text-center sm:p-16">
        <p className="font-mono text-sm text-muted">nothing on your watchlist yet</p>
        <p className="mt-2 font-mono text-xs text-muted">tap the ★ on any artwork to keep an eye on it</p>
      </div>
    )
  }
  return (
    <div className={OVAL_GRID}>
      {entries.map((e) => (
        <MomentOval
          key={`${e.address}:${e.tokenId}`}
          moment={momentFromEntry(e)}
          ethUsd={ethUsd}
          resaleCount={resaleCounts?.get(`${e.address.toLowerCase()}:${e.tokenId}`)}
        />
      ))}
    </div>
  )
}

// Centered platform-stats dialog, opened by the header's "stats" pill. One
// headline (all-time gross volume across both markets) over the three
// creation/collection counters — all from the /api/stats/platform payload the
// page already fetched, so opening it costs zero requests. Fields render '—'
// until their snapshot exists (the API emits null, never fabricated zeros).
// Same overlay conventions as the filters drawer: z-[70], Escape, scroll lock,
// backdrop tap.
function StatsModal({ stats, onClose }: { stats: PlatformStats | null; onClose: () => void }) {
  useEscapeKey(onClose)
  useBodyScrollLock()
  // Headline denomination — tap the figure to flip USD ↔ ETH. Resets to USD
  // per open (state dies with the unmount), matching the header glance line.
  const [denom, setDenom] = useState<'usd' | 'eth'>('usd')
  const count = (n: number | null | undefined) => (typeof n === 'number' ? n.toLocaleString() : '—')
  const headline =
    denom === 'usd'
      ? stats?.volumeUsd != null
        ? fmtUsd(stats.volumeUsd)
        : '—'
      : stats?.volumeEth != null
        ? fmtEth(stats.volumeEth)
        : '—'
  // Scoping is deliberate and split: the two CATALOG rows count only VISIBLE
  // work (hidden artworks excluded; artists whose every piece is hidden
  // excluded) so the counters match what the feeds actually show, while the
  // two SALES rows are TRUE totals — a sale happened whether or not the work
  // is hidden today, and un-counting it would misstate market history.
  const rows: Array<[string, string]> = [
    ['artists', count(stats?.artists)],
    ['artworks minted', count(stats?.mints)],
    // Distinct paying collectors on art sales (sales.collectors) — art-scoped
    // like every other counter here, so pass buyers don't inflate it.
    ['collectors', count(stats?.collectors)],
    // "artworks sold" counts sold edition UNITS (each copy in a collector's
    // wallet) — deliberately not distinct works, which is what "artworks
    // minted" above already counts.
    ['artworks sold', count(stats?.editionsSold)],
  ]
  // Portaled to <body>: this mounts inside the sticky header, whose z-40 +
  // position (sm+) makes it a stacking context — a fixed overlay declared
  // there paints UNDER the z-50 nav on desktop while covering it on mobile
  // (where sm:sticky is off and no context forms). The portal escapes the
  // ancestor context so the backdrop covers the full viewport, nav included,
  // on every breakpoint. Mounted only while open (client-side, post-
  // hydration), so document.body is always available.
  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Platform stats"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-xs border border-line bg-[#0d0d0d] p-6">
        <button
          onClick={onClose}
          aria-label="Close stats"
          className="absolute right-2.5 top-2.5 p-1 text-dim transition-colors hover:text-ink"
        >
          <X size={14} />
        </button>
        {/* "Total sales volume" — kept "sales" (every dollar here is a sale:
            mint, pass, or resale fill) so it can't read as earnings next to
            the header's "$— earned" line; "total" says both markets, all
            time. Ink, not a faint kicker — the section title must be legible
            at a glance. */}
        <p className="font-mono text-[10px] uppercase tracking-widest text-ink">total sales volume</p>
        {/* The figure is the denomination toggle. Same precedent as the USD
            view itself: cross-currency legs convert at today's Chainlink price
            with no inline caveat (the header's "$—K earned" glance line has
            always worked this way). The brand mark sits opposite — decorative
            (empty alt + aria-hidden; the dialog itself is already labeled). */}
        <div className="mt-1 flex items-center justify-between gap-3">
          <button
            onClick={() => setDenom((v) => (v === 'usd' ? 'eth' : 'usd'))}
            aria-pressed={denom === 'eth'}
            aria-label={denom === 'usd' ? 'Show sales volume in ETH' : 'Show sales volume in USD'}
            title={denom === 'usd' ? 'show in ETH' : 'show in USD'}
            className="block font-mono text-3xl tabular-nums accent-grad transition-opacity hover:opacity-80"
          >
            {headline}
          </button>
          {/* 40px is deliberate cache alignment, not just prominence: the
              optimizer rounds 40px to the same srcset variants (w=48 / w=96)
              Nav's 36px logo already loaded, so the mark paints instantly
              from cache — at 32px the retina candidate was w=64, a variant
              nothing had fetched, which popped in on modal open. priority
              skips the lazy-load observer tick for the same reason. */}
          <Image
            src="/logo.png"
            alt=""
            width={40}
            height={40}
            className="object-contain"
            aria-hidden
            priority
          />
        </div>
        <p className="mt-1 font-mono text-[10px] text-dim">primary + secondary</p>
        <dl className="mt-5 space-y-2.5 border-t border-line pt-4">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="font-mono text-xs text-dim">{label}</dt>
              <dd className="font-mono text-sm tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>,
    document.body,
  )
}

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
  const [statsOpen, setStatsOpen] = useState(false)
  // Cross-market bridge: "collection:tokenId" → live-resale count, from one
  // bounded, edge-cached request. Fetched once — the map is market-independent.
  const [resaleCounts, setResaleCounts] = useState<Map<string, number> | null>(null)
  // Per-collection floors from the same snapshot — drives the drawer's
  // collection-picker labels ("casa · floor 0.005 ETH").
  const [floors, setFloors] = useState<Record<string, { eth?: string; usdc?: string }> | null>(null)
  const pageLimit = isMobile ? 20 : 24
  const infiniteScroll = !isMobile

  useEffect(() => {
    let cancelled = false
    fetch('/api/listings?keys=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        if (Array.isArray(d?.keys)) {
          const m = new Map<string, number>()
          for (const k of d.keys as unknown[]) {
            if (typeof k === 'string') m.set(k, (m.get(k) ?? 0) + 1)
          }
          setResaleCounts(m)
        }
        if (d?.floors && typeof d.floors === 'object') setFloors(d.floors)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // All state changes flow through here so the URL and component state can
  // never disagree. push=true for navigation-grade changes (market, sort);
  // refinements replace so pill-tapping doesn't pollute history.
  //
  // The next state is computed OUTSIDE setState, from a render-phase ref
  // mirror: React may re-invoke updater functions (StrictMode dev double-
  // invoke; concurrent re-renders), and a pushState inside the updater minted
  // duplicate history entries — one market tap, two back-presses. Event
  // handlers run once, so computing here calls history exactly once.
  // reconcileState keeps every transition inside the server-expressible space
  // (e.g. switching to a sales sort drops an active free filter with it).
  const stateRef = useRef(state)
  stateRef.current = state
  const update = useCallback((patch: Partial<DiscoverState>, opts?: { push?: boolean }) => {
    const next = reconcileState({ ...stateRef.current, ...patch })
    setState(next)
    try {
      if (opts?.push) window.history.pushState(null, '', discoverUrl(next))
      else window.history.replaceState(null, '', discoverUrl(next))
    } catch {}
  }, [])

  // Funnel: one discover visit per session (SESSION_ONCE dedupes back-navs).
  useEffect(() => {
    trackFunnel('discover_landing')
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

  // Keyboard navigation: j/k move focus across the ovals' stretched links;
  // Enter opens the focused one (native anchor behavior — no handler).
  // Guarded off inside inputs/selects/editables and while any dialog (the
  // filters drawer) is open. Collect deliberately has NO key — a single
  // unmodified keystroke must never reach a wallet flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'j' && e.key !== 'k') || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (document.querySelector('[role="dialog"]')) return
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[data-oval-nav]'))
      if (links.length === 0) return
      const idx = links.indexOf(document.activeElement as HTMLAnchorElement)
      const next = e.key === 'j' ? Math.min(idx + 1, links.length - 1) : Math.max(idx - 1, 0)
      const el = links[next]
      if (!el) return
      e.preventDefault()
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'center' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
        // Volume = primary (volume block: art + passes) + secondary (resales).
        // The API blesses exactly this addition for all-time gross. Same
        // no-masquerade rule the API applies to its own volume block: no
        // headline unless the PRIMARY total exists (a resales-only sum would
        // present a sliver as "total volume" during the deploy window where the
        // snapshot predates the passes field). resales null just means no
        // Kismet resale yet — that leg contributes 0, not a veto.
        const primaryVol = typeof d?.volume?.usd === 'number' ? d.volume.usd : null
        const resaleVol = typeof d?.resales?.usd === 'number' ? d.resales.usd : null
        const ethUsd = typeof d?.earnings?.ethUsd === 'number' ? d.earnings.ethUsd : null
        // ETH denomination of the same total, from the payload's per-currency
        // legs. Same primary-block veto as volumeUsd; USDC converts at the
        // same price usd was derived with, or the figure nulls rather than
        // dropping the USDC leg silently.
        let volumeEth: number | null = null
        if (primaryVol != null) {
          const ethLeg =
            (typeof d.volume.eth === 'number' ? d.volume.eth : 0) +
            (typeof d?.resales?.eth === 'number' ? d.resales.eth : 0)
          const usdcLeg =
            (typeof d.volume.usdc === 'number' ? d.volume.usdc : 0) +
            (typeof d?.resales?.usdc === 'number' ? d.resales.usdc : 0)
          volumeEth = usdcLeg === 0 ? ethLeg : ethUsd ? ethLeg + usdcLeg / ethUsd : null
        }
        setStats({
          // Visible-scoped (hidden artworks excluded) — the header glance line
          // and the dialog's "artworks minted" must match what feeds show.
          // Null-guarded per the deploy-window rule: a pre-field snapshot
          // renders '—' rather than silently falling back to the hidden-
          // inclusive total.
          mints: typeof d?.catalog?.visibleArtworks === 'number' ? d.catalog.visibleArtworks : null,
          earningsUsd: typeof d?.earnings?.total?.usd === 'number' ? d.earnings.total.usd : null,
          resaleUsd: resaleVol,
          ethUsd,
          volumeUsd: primaryVol == null ? null : primaryVol + (resaleVol ?? 0),
          volumeEth,
          artists: typeof d?.catalog?.visibleArtists === 'number' ? d.catalog.visibleArtists : null,
          collectors: typeof d?.sales?.collectors === 'number' ? d.sales.collectors : null,
          editionsSold: typeof d?.sales?.editionsSold === 'number' ? d.sales.editionsSold : null,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const market = state.market
  const filtered = hasActiveFilters(state)

  // ── Last-visit divider. Captured once per mount (the PREVIOUS visit), then
  // the marker is advanced to now — so the divider marks everything minted
  // since you last opened discover. Client-only by construction: the grid's
  // items never SSR (react-query is pending on the server), so the divider
  // can't cause a hydration mismatch.
  const [lastVisit] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(LAST_VISIT_KEY)
      const n = raw ? Number(raw) : NaN
      return Number.isFinite(n) && n > 0 ? n : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(LAST_VISIT_KEY, String(Date.now()))
    } catch {}
  }, [])
  // Only meaningful on the chronological view — any other sort interleaves
  // ages and the boundary would lie.
  const renderBetween =
    market === 'primary' && state.sortP === 'new' && lastVisit !== null
      ? (prev: Moment, next: Moment) => {
          const prevTs = new Date(prev.created_at).getTime()
          const nextTs = new Date(next.created_at).getTime()
          if (!(prevTs > lastVisit && nextTs <= lastVisit)) return null
          return (
            <div className="col-span-full flex items-center gap-3 px-1" aria-hidden>
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-accent/70">
                new since your last visit ↑
              </span>
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
            </div>
          )
        }
      : undefined

  // ── Live pulse: a visibility-gated 60s poll of the feed's own first page
  // (tiny limit → its own shared edge-cache family). The first poll sets the
  // baseline; later polls count mints newer than it. Tap = scroll to top THEN
  // refresh, so the reset never teleports a deep-scrolled reader.
  const gridRefreshRef = useRef<(() => void) | null>(null)
  const onRefreshReady = useCallback((fn: () => void) => {
    gridRefreshRef.current = fn
  }, [])
  const [newCount, setNewCount] = useState(0)
  const pulseBaselineRef = useRef<number | null>(null)
  const pulseUrl =
    market === 'primary' && state.sortP === 'new' && !state.watchlist ? primaryApiUrl(state) : null
  useEffect(() => {
    // Leaving the chronological view (sort change, watchlist, secondary) must
    // also CLEAR any showing badge — otherwise a stale "N new mints" floats
    // over a feed it doesn't describe and its tap refreshes the wrong thing.
    if (!pulseUrl) {
      pulseBaselineRef.current = null
      setNewCount(0)
      return
    }
    pulseBaselineRef.current = null
    setNewCount(0)
    let cancelled = false
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const res = await fetch(`${pulseUrl}&page=1&limit=10`)
        if (!res.ok) return
        const d = (await res.json()) as { moments?: { created_at?: string }[] }
        const moments = Array.isArray(d?.moments) ? d.moments : []
        if (cancelled || moments.length === 0) return
        const newest = new Date(moments[0]?.created_at ?? 0).getTime()
        if (!Number.isFinite(newest) || newest <= 0) return
        if (pulseBaselineRef.current === null) {
          pulseBaselineRef.current = newest
          return
        }
        const count = moments.filter(
          (m) => new Date(m.created_at ?? 0).getTime() > pulseBaselineRef.current!,
        ).length
        if (count > 0) setNewCount(count)
      } catch {}
    }
    void poll()
    const id = setInterval(() => void poll(), PULSE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [pulseUrl])
  const onPulseTap = () => {
    setNewCount(0)
    pulseBaselineRef.current = null
    window.scrollTo({ top: 0 })
    gridRefreshRef.current?.()
  }

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

  const pulseButton = (
    <button
      onClick={onPulseTap}
      className="rounded-full border border-accent bg-[#141414] px-4 py-1.5 font-mono text-[11px] text-accent shadow-[0_4px_18px_rgba(224,81,47,0.25)] transition-colors hover:bg-accent/10"
    >
      ● {newCount >= 10 ? '10+' : newCount} new mint{newCount === 1 ? '' : 's'} — tap to refresh
    </button>
  )

  // The control surface — toggle + totals + pill bar — rendered ONCE above
  // whichever content branch is active. sm+: sticky under the fixed nav so
  // filters stay reachable while the wall scrolls (the grid's own row keeps
  // just its refresh button). Mobile: in-flow — vertical space is too precious
  // for a permanent bar. Opaque bg + border-b so ovals scroll cleanly under.
  // z-40 sits above the ovals' z-10 stars and below the drawer (z-70) and nav
  // overlays; the pill popovers (z-30) live inside this stacking context.
  const stickyHeader = (
    <div
      className="z-40 border-b border-line bg-[#0d0d0d] pb-3 pt-4 sm:sticky"
      style={{ top: 'calc(3.5rem + var(--safe-top))' }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          {/* overflow-hidden: the active pill is its own rounded-full — at
              fractional device-pixel ratios its corner arc can poke past the
              container's inner curve and sit on the border. Clipping to the
              container keeps the two radii visually concentric everywhere. */}
          <div className="inline-flex overflow-hidden rounded-full border border-accent/40 bg-[#141414] p-0.5">
            {(['primary', 'secondary'] as const).map((m) => (
              <button
                key={m}
                aria-pressed={market === m}
                onClick={() => update({ market: m }, { push: true })}
                className={`rounded-full px-4 py-1.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                  // a11y-ok: dark text on the accent pill (bg-accent), not the #111 surface
                  market === m ? 'bg-accent font-semibold text-[#0d0d0d]' : 'text-muted hover:text-dim'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          <div className="text-right leading-tight">
            <div className="font-mono text-[11px] uppercase tracking-widest text-subtle">{market} market</div>
            <div className="mt-0.5 font-mono text-xs tabular-nums text-muted">{statLine}</div>
            {/* The glance line above stays; this opens the full-figure dialog. */}
            <button
              onClick={() => setStatsOpen(true)}
              aria-haspopup="dialog"
              className="mt-1.5 rounded-full border border-line px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-dim transition-colors hover:border-accent/40 hover:text-ink"
            >
              stats
            </button>
          </div>
        </div>
        {statsOpen && <StatsModal stats={stats} onClose={() => setStatsOpen(false)} />}
        <DiscoverPillBar
          state={state}
          floors={floors}
          onChange={(patch) => {
            // Filter engagement — pills and drawer refinements only; sort
            // changes route through onSortChange and don't count.
            trackFunnel('discover_filter')
            update(patch)
          }}
          onSortChange={(patch) => update(patch, { push: true })}
        />
      </div>
      {/* sm+ pulse lives IN the bar — visible whenever the bar is, including
          deep scroll. The mobile fixed variant renders in the primary branch. */}
      {newCount > 0 && <div className="hidden justify-center pt-2 sm:flex">{pulseButton}</div>}
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

  // Watchlist is its own view (never a feed filter — see WatchlistView).
  if (market === 'primary' && state.watchlist) {
    return (
      <>
        {stickyHeader}
        <div className="pt-4">
          <WatchlistView ethUsd={stats?.ethUsd} resaleCounts={resaleCounts} />
        </div>
      </>
    )
  }

  if (market === 'primary') {
    return (
      <>
        {stickyHeader}
        {newCount > 0 && (
          <div
            // Mobile only — the bar isn't sticky there, so the pulse floats
            // fixed under the nav; sm+ reads it inside the sticky bar instead.
            style={{ top: 'calc(3.5rem + var(--safe-top) + 12px)' }}
            className="fixed left-1/2 z-40 -translate-x-1/2 sm:hidden"
          >
            {pulseButton}
          </div>
        )}
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
          renderBetween={renderBetween}
          onRefreshReady={onRefreshReady}
          renderItem={(m) => (
            <MomentOval
              key={`${m.address}:${m.token_id}`}
              moment={m}
              ethUsd={stats?.ethUsd}
              resaleCount={resaleCounts?.get(`${m.address.toLowerCase()}:${m.token_id}`)}
            />
          )}
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
      </>
    )
  }

  return (
    <>
      {stickyHeader}
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
        renderItem={(l, { remove }) => <ListingOval key={l.id} listing={l} onRemove={remove} />}
        empty={
          filtered ? (
            filteredEmpty
          ) : (
            <div className="border border-line p-8 text-center sm:p-16">
              <p className="font-mono text-sm text-muted">no live resales</p>
              <p className="mt-2 font-mono text-xs text-muted">
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
    </>
  )
}
