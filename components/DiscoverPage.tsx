'use client'

import { createContext, useContext, useState, useEffect, useRef, useCallback, startTransition } from 'react'
import { useAccount } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { feedPageLimit, prefetchPaginatedFirstPage } from '@/lib/paginatedGridQuery'
import { MomentCard } from '@/components/MomentCard'
import { CollectionCard, type CollectionDisplay } from '@/components/CollectionCard'
import { FeaturedFeed, type InitialFeatured } from '@/components/FeaturedFeed'
import { FeedSkeleton } from '@/components/FeedSkeleton'
import { PaginatedGrid } from '@/components/PaginatedGrid'
import { ViewModeToggle } from '@/components/ViewModeToggle'
import { useViewMode } from '@/hooks/useViewMode'
import { useLongPressDrag } from '@/hooks/useLongPressDrag'
import type { Moment } from '@/lib/inprocess'
import { trackFunnel } from '@/lib/funnel'
import { useAdmin } from '@/contexts/AdminContext'

// Mobile-mount context. Server-side UA detection (see app/page.tsx)
// sets this to `true` on mobile UAs, baking the decision into SSR
// HTML so client hydration matches exactly. Desktop never sees a
// truthy value here — every PaginatedGrid consumer below renders
// eagerly on every render. No client-side flip, no hydration window
// where desktop briefly touches the lazy code path.
const LazyMountCtx = createContext(false)

// ─── types ───────────────────────────────────────────────────────────────────

type TabId = 'featured' | 'trending' | 'main' | 'roster'

// Default order — featured leads so a first-time visitor lands on the
// curated tab. Existing users who reordered keep their saved positions
// (see loadOrder), so changing this only affects fresh installs.
const DRAGGABLE: TabId[] = ['featured', 'trending', 'main', 'roster']
const LABEL: Record<TabId, string> = {
  featured: 'featured',
  trending: 'trending',
  main: 'main',
  roster: 'artists',
}

const ORDER_KEY = 'kismetart:tab-order'
const ACTIVE_KEY = 'kismetart:active-tab'

// First-page apiUrls for the tabs whose feed runs through PaginatedGrid
// (react-query). Warming these into the query cache before the tab is
// clicked turns the first tap from a cold network round-trip (skeleton →
// 1-2s wait on the Mini App webview's constrained pool) into an instant
// cache hit. Must match the apiUrl each tab's feed passes to PaginatedGrid
// verbatim, or the prefetched entry won't dedupe against the live query:
//   trending → TrendingFeed's default sort (latest-sales)
//   main     → MainFeed's mints sub-tab default (no `following=`)
// featured (raw fetch, not react-query) and roster (depends on an async
// creator-lists fetch) are intentionally excluded; featured is also the
// default landing tab, so it loads on first paint regardless.
const PREFETCH_URL: Partial<Record<TabId, string>> = {
  trending: '/api/timeline?sort=latest-sales&scope=standalone',
  main: '/api/timeline?scope=standalone',
}

// Reconcile a stored tab order with the current DRAGGABLE list: keep
// recognized entries in their saved positions, drop unknowns, and append
// any newly-added tabs at the end. Without the reconcile, adding a new
// draggable tab (like 'roster') would invalidate every existing user's
// stored order and reset them all to defaults.
function loadOrder(): TabId[] {
  if (typeof window === 'undefined') return DRAGGABLE
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return DRAGGABLE
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DRAGGABLE
    const valid = parsed.filter(
      (t): t is TabId => typeof t === 'string' && DRAGGABLE.includes(t as TabId),
    )
    const missing = DRAGGABLE.filter((t) => !valid.includes(t))
    return [...valid, ...missing]
  } catch {
    return DRAGGABLE
  }
}

// Load the user's last-active tab, falling back to the leftmost tab in
// the resolved order. Validates against `order` so a stale saved value
// (e.g. tab was removed in a future release) doesn't strand the user
// on a non-existent tab.
function loadActiveTab(order: TabId[]): TabId {
  if (typeof window === 'undefined') return order[0]
  try {
    const raw = localStorage.getItem(ACTIVE_KEY)
    if (raw && order.includes(raw as TabId)) return raw as TabId
  } catch {}
  return order[0]
}

// ─── tab bar ─────────────────────────────────────────────────────────────────

function TabBar({
  order,
  active,
  onSelect,
  onReorder,
  onIntent,
}: {
  order: TabId[]
  active: TabId
  onSelect: (t: TabId) => void
  onReorder: (o: TabId[]) => void
  /** Hover-intent prefetch (desktop). Mouse-only so it never collides with
   *  the touch drag-reorder path; mobile relies on the idle warm-up. */
  onIntent?: (t: TabId) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { draggingId: draggingTab, dragOffset, bindItem } = useLongPressDrag<TabId>({
    axis: 'x',
    order,
    onReorder,
    onTap: onSelect,
    containerRef,
    itemSelector: '[data-tab]',
  })

  return (
    <div ref={containerRef} className="flex items-end gap-0 border-b border-line">
      {order.map((tab) => {
        const isActive = tab === active
        const isDragging = tab === draggingTab
        return (
          <button
            key={tab}
            data-tab={tab}
            {...bindItem(tab)}
            onMouseEnter={() => onIntent?.(tab)}
            // Keyboard activation lives outside the pointer path —
            // onClick would race the pointer-tap handler on touch.
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab)
              }
            }}
            // touch-pan-y pre-drag keeps vertical page scroll past the
            // bar working; the inline `touchAction: none` during drag
            // locks the horizontal swap from the browser. scale + shadow
            // give a clear "lifted" cue beyond the opacity drop alone.
            style={isDragging
              ? {
                  transform: `translate3d(${dragOffset}px, 0, 0) scale(1.05)`,
                  zIndex: 10,
                  touchAction: 'none',
                  boxShadow: '0 6px 16px rgba(0, 0, 0, 0.45)',
                }
              : undefined}
            className={`
              relative px-4 py-2.5 text-xs font-mono tracking-wider uppercase
              transition-colors select-none touch-pan-y
              ${isActive ? 'text-ink' : 'text-subtle hover:text-dim'}
              ${isDragging ? 'opacity-70 cursor-grabbing' : 'cursor-grab'}
            `}
          >
            {LABEL[tab]}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-px bg-ink" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ─── moment feed ─────────────────────────────────────────────────────────────

function MomentFeed({
  apiUrl,
  emptyMessage = 'nothing here yet',
  header,
  withViewToggle = false,
}: {
  apiUrl: string
  emptyMessage?: string
  header?: React.ReactNode
  /**
   * Renders a `<ViewModeToggle>` inline with `header`. The view-mode
   * value itself is read from the global `useViewMode` hook regardless —
   * the toggle is just UI placement. Leave false when a parent already
   * renders the toggle elsewhere (e.g. MainFeed shares one toggle across
   * its mints + collections sub-tabs).
   */
  withViewToggle?: boolean
}) {
  const lazy = useContext(LazyMountCtx)
  const [viewMode, setViewMode] = useViewMode()

  const headerWithToggle = withViewToggle ? (
    <div className="flex items-center gap-3 flex-wrap">
      <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      {header}
    </div>
  ) : header

  // One row above-the-fold: 3 cards on feed (lg+), 6 cards on grid (lg+).
  const isGrid = viewMode === 'grid'
  const eagerCount = isGrid ? 6 : 3
  return (
    <PaginatedGrid<Moment>
      apiUrl={apiUrl}
      itemsKey="moments"
      getKey={(m) => `${m.address}-${m.token_id}`}
      viewMode={viewMode}
      lazy={lazy}
      // Smaller page on mobile/miniapp: 10 ≈ two viewports of the 2-col
      // grid (five rows) before "load more", and every unit off the limit
      // compounds server-side — /api/timeline's per-collection sample is
      // page×limit, so page 1 pulls ~17% less upstream JSON + merge heap
      // than the previous 12 and each deeper page widens the gap. Client
      // cost is already bounded elsewhere (LazyMount eager-mounts 4, the
      // video coordinator caps play/buffer slots), so payload + fan-out is
      // the lever the limit actually controls. Desktop has capacity for 18.
      pageLimit={feedPageLimit(lazy)}
      renderItem={(m, { index }) => (
        <MomentCard
          key={`${m.address}-${m.token_id}`}
          moment={m}
          compact={isGrid}
          showCreator
          priority={index < eagerCount}
          isMobile={lazy}
        />
      )}
      empty={
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">{emptyMessage}</p>
        </div>
      }
      header={headerWithToggle}
    />
  )
}

// ─── collections feed (paginated grid) ───────────────────────────────────────

function CollectionsFeed({
  followingAddrs,
  header,
}: {
  followingAddrs?: string[]
  header?: React.ReactNode
}) {
  const lazy = useContext(LazyMountCtx)
  const [viewMode] = useViewMode()
  const followingSet = followingAddrs
    ? new Set(followingAddrs.map((a) => a.toLowerCase()))
    : null
  const filter = followingSet
    ? (items: CollectionDisplay[]) =>
        items.filter((c) => {
          const admin = (c as { default_admin?: { address?: string } }).default_admin?.address?.toLowerCase()
          return admin ? followingSet.has(admin) : false
        })
    : undefined
  const isGrid = viewMode === 'grid'
  const eagerCount = isGrid ? 6 : 3
  return (
    <PaginatedGrid<CollectionDisplay>
      apiUrl="/api/collections?feed=1"
      itemsKey="collections"
      getKey={(c) => c.contractAddress}
      viewMode={viewMode}
      lazy={lazy}
      pageLimit={feedPageLimit(lazy)}
      renderItem={(c, { index }) => (
        <CollectionCard
          key={c.contractAddress}
          collection={c}
          compact={isGrid}
          showCreator={isGrid}
          priority={index < eagerCount}
        />
      )}
      filter={filter}
      header={header}
      empty={
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">no collections yet</p>
        </div>
      }
    />
  )
}

// ─── filter pill ─────────────────────────────────────────────────────────────

// The accent-bordered toggle pill shared by the main feed's "following"
// button and the trending feed's sort buttons — one source so the two
// surfaces can't drift visually. (The roster list buttons keep their own
// ink-bordered variant deliberately: they're content selectors, not filters.)
function FilterPill({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 border transition-colors ${
        on
          ? 'border-accent text-accent'
          : 'border-line text-muted hover:border-subtle hover:text-dim'
      }`}
    >
      {children}
    </button>
  )
}

// ─── trending feed with sort buttons ─────────────────────────────────────────

type TrendingSort = 'latest-sales' | 'trending' | 'ending-soon'

// Per-sort config, in display order: API sort value, button label, empty-state
// copy. 'trending' is the original all-time collect-count sort, relabeled
// "most sales" now that it has siblings; the API value stays 'trending' so
// the roster feed and any cached clients keep working unchanged.
const TRENDING_SORTS: { id: TrendingSort; label: string; empty: string }[] = [
  {
    id: 'latest-sales',
    label: 'latest sales',
    empty: 'no collects recorded yet — latest sales appear as mints are collected',
  },
  {
    id: 'trending',
    label: 'most sales',
    empty: 'no collects recorded yet — trending appears as mints are collected',
  },
  { id: 'ending-soon', label: 'ending soon', empty: 'no active timed sales right now' },
]

function TrendingFeed() {
  const [sort, setSort] = useState<TrendingSort>('latest-sales')
  const active = TRENDING_SORTS.find((s) => s.id === sort) ?? TRENDING_SORTS[0]

  // Radio-style row of FilterPills: exactly one sort active at a time.
  // Switching sorts swaps the PaginatedGrid apiUrl — react-query keeps each
  // sort's pages cached, so flipping back is instant.
  const sortButtons = (
    <div className="flex items-center gap-1.5 flex-wrap">
      {TRENDING_SORTS.map(({ id, label }) => (
        <FilterPill key={id} on={sort === id} onClick={() => setSort(id)}>
          {label}
        </FilterPill>
      ))}
    </div>
  )

  return (
    <MomentFeed
      apiUrl={`/api/timeline?sort=${sort}&scope=standalone`}
      emptyMessage={active.empty}
      header={sortButtons}
      withViewToggle
    />
  )
}

// ─── main feed with sub-tabs (mints / collections) ───────────────────────────

type MainSubTab = 'mints' | 'collections'

function MainFeed() {
  const { address } = useAccount()
  const [subTab, setSubTab] = useState<MainSubTab>('mints')
  const [followingOn, setFollowingOn] = useState(false)
  const [followingAddrs, setFollowingAddrs] = useState<string[]>([])
  const [viewMode, setViewMode] = useViewMode()

  useEffect(() => {
    if (!address || !followingOn) { setFollowingAddrs([]); return }
    fetch(`/api/follow/${address}?list=1`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setFollowingAddrs(Array.isArray(d.addresses) ? d.addresses : []))
      .catch(() => setFollowingAddrs([]))
  }, [address, followingOn])

  // scope=standalone keeps collection moments out of the mints sub-tab —
  // they surface inside their collection card instead of appearing twice.
  const apiUrl = followingAddrs.length
    ? `/api/timeline?scope=standalone&following=${followingAddrs.join(',')}`
    : '/api/timeline?scope=standalone'

  // Single toggle controls both sub-tabs — switching mints↔collections
  // preserves the active layout instead of forcing a re-toggle. The
  // toggle sits leftmost in the bar per the design spec.
  const subTabBar = (
    <div className="flex items-center gap-3 flex-wrap">
      <ViewModeToggle mode={viewMode} onChange={setViewMode} />
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setSubTab('mints')}
          className={`text-xs font-mono tracking-wider transition-colors ${
            subTab === 'mints' ? 'text-ink' : 'text-subtle hover:text-dim'
          }`}
        >
          mints
        </button>
        <span className="text-xs font-mono text-line select-none">/</span>
        <button
          onClick={() => setSubTab('collections')}
          className={`text-xs font-mono tracking-wider transition-colors ${
            subTab === 'collections' ? 'text-ink' : 'text-subtle hover:text-dim'
          }`}
        >
          collections
        </button>
      </div>
      {address && (
        <FilterPill on={followingOn} onClick={() => setFollowingOn((v) => !v)}>
          following
        </FilterPill>
      )}
    </div>
  )

  if (subTab === 'collections') {
    return (
      <CollectionsFeed
        followingAddrs={followingOn && followingAddrs.length > 0 ? followingAddrs : undefined}
        header={subTabBar}
      />
    )
  }

  return (
    <MomentFeed
      apiUrl={apiUrl}
      emptyMessage="no moments yet — be the first to mint"
      header={subTabBar}
    />
  )
}

// ─── discover page ────────────────────────────────────────────────────────────

export function DiscoverPage({
  isMobile,
  initialFeatured = null,
}: {
  isMobile: boolean
  /** Featured-tab payload fetched during SSR (app/page.tsx). When present the
   *  featured tab renders real content in the server HTML and through the
   *  hydration gate below — with NO client fetch, so it cannot race a saved
   *  non-default tab (the race the gate exists to prevent). null = SSR fetch
   *  failed/skipped; behavior is exactly as before. */
  initialFeatured?: InitialFeatured | null
}) {
  const { isAdmin, hasSession, startSession, featuredRevision } = useAdmin()
  const queryClient = useQueryClient()
  // Mirror MomentFeed's page size so a warmed entry shares the live grid's
  // exact query key — feedPageLimit is the single source (10 on mobile AND
  // in any iframe/miniapp context, 18 on standalone desktop).
  const pageLimit = feedPageLimit(isMobile)
  const [order, setOrder] = useState<TabId[]>(DRAGGABLE)
  const [active, setActive] = useState<TabId>(DRAGGABLE[0])
  // Defer the first tab-content render until we've reconciled with
  // localStorage. Without the gate, we'd mount whatever DRAGGABLE[0]
  // points at, fire its PaginatedGrid useQuery, then immediately
  // unmount it once the effect below flips `active` to the saved
  // order/active-tab. That wasted fetch races the real tab's fetches
  // against the Mini App webview's already-constrained connection pool
  // and delays time-to-content. One paint cycle of "loading…" is the
  // cost — applies on both desktop and mobile now that touch drag-
  // reorder (long-press) can produce a saved order on either platform.
  const [hydrated, setHydrated] = useState(false)

  // Keep-alive: visited tabs stay mounted, hidden via `hidden` on
  // switch (instant returns, scroll preserved). Set-during-render keeps
  // the active tab in the set across the hydration flip without a
  // follow-up effect; functional updater so concurrent-mode can't drop
  // an active value if a render is interrupted and replayed.
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(() => new Set([DRAGGABLE[0]]))
  if (!visitedTabs.has(active)) {
    setVisitedTabs((prev) => prev.has(active) ? prev : new Set([...prev, active]))
  }

  useEffect(() => {
    const savedOrder = loadOrder()
    setOrder(savedOrder)
    setActive(loadActiveTab(savedOrder))
    setHydrated(true)
  }, [])

  // Funnel: one landing per session (trackFunnel dedupes via sessionStorage),
  // fired from the landing surface itself so back-navs don't recount.
  useEffect(() => {
    trackFunnel('landing')
  }, [])

  // Warm a tab's first page into the react-query cache. No-op for tabs not
  // in PREFETCH_URL (featured/roster) and a cheap cache-hit if already warm.
  const prefetchTab = useCallback(
    (tab: TabId) => {
      const url = PREFETCH_URL[tab]
      if (url) prefetchPaginatedFirstPage(queryClient, url, pageLimit)
    },
    [queryClient, pageLimit],
  )

  // Idle warm-up: once the landing tab has settled, prefetch the other
  // PaginatedGrid-backed tabs (trending / main) so the FIRST tap on either
  // renders from cache instead of waiting on a cold fetch over the Mini App
  // webview's constrained connection pool. This is the mobile path's win —
  // there's no hover to prefetch on, so we warm on idle instead. Skips the
  // currently-active tab (its own useQuery already owns that request) and
  // yields via requestIdleCallback so it never contends with the active
  // tab's initial load.
  useEffect(() => {
    if (!hydrated) return
    const run = () => {
      for (const tab of Object.keys(PREFETCH_URL) as TabId[]) {
        if (tab !== active) prefetchTab(tab)
      }
    }
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (w.requestIdleCallback) {
      const handle = w.requestIdleCallback(run, { timeout: 2000 })
      return () => w.cancelIdleCallback?.(handle)
    }
    const t = setTimeout(run, 800)
    return () => clearTimeout(t)
  }, [hydrated, active, prefetchTab])

  function handleReorder(next: TabId[]) {
    setOrder(next)
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)) } catch {}
  }

  const handleSelect = useCallback((tab: TabId) => {
    // startTransition lets React's concurrent scheduler keep the
    // tap-feedback (button color flip, chevron rotate) at high
    // priority while the heavy tab-content swap (unmount old feed,
    // mount new feed, fire fetches) runs at lower priority. On
    // slow Mini App webviews this is the difference between
    // "tap registers instantly" and "tap appears stuck while
    // the new content fights for the main thread".
    startTransition(() => setActive(tab))
    try { localStorage.setItem(ACTIVE_KEY, tab) } catch {}
  }, [])

  // Featured runs at the wider 88rem cap (same as the moment detail
  // overlay) so each featured collection's preview can lay its mints
  // out 10-across at a readable ~130px per card. Other tabs stay at
  // max-w-6xl — they're standard moment / collection grids that read
  // fine at the narrower width.
  const widerTab = active === 'featured'

  return (
    <LazyMountCtx.Provider value={isMobile}>
    <div className={`${widerTab ? 'max-w-[88rem]' : 'max-w-6xl'} mx-auto px-4 py-6`}>
      <TabBar
        order={order}
        active={active}
        onSelect={handleSelect}
        onReorder={handleReorder}
        onIntent={prefetchTab}
      />

      <div className="mt-2">
        {/* Pre-hydration: a pulse skeleton instead of bare "loading…" text.
            With SSR featured data the real featured branch below renders
            through the gate instead (zero fetches — initial data only), so
            the landing HTML carries content, not a placeholder. */}
        {!hydrated && !initialFeatured && <FeedSkeleton count={8} />}
        {(hydrated || !!initialFeatured) && visitedTabs.has('featured') && (
          <div hidden={active !== 'featured'}>
            {isAdmin && !hasSession && (
              <div className="flex items-center justify-between py-4 border-b border-line mb-2">
                <p className="text-xs font-mono text-muted">
                  admin — sign to start curating
                </p>
                <button
                  onClick={startSession}
                  className="text-xs font-mono px-3 py-1.5 border border-line text-dim hover:border-muted hover:text-ink transition-colors"
                >
                  sign in
                </button>
              </div>
            )}
            <FeaturedFeed
              // Remount-to-refetch on a real curation change (feature, un-
              // feature, collection, or Mint Pass Display) via a counter that
              // only the toggles bump. Keying on the set *contents* instead
              // would also remount when they first populate from /api/featured
              // — a wasteful double-fetch of the tab's heaviest endpoints on
              // every initial load. The hero reacts to mintPassKeys reactively
              // (no remount needed) for that initial-populate case.
              key={`featured-${featuredRevision}`}
              emptyMessage={isAdmin ? 'no featured mints or collections yet — click ★ on any mint or collection to feature it' : 'no featured mints or collections yet'}
              isMobile={isMobile}
              initialFeatured={initialFeatured}
            />
          </div>
        )}

        {hydrated && visitedTabs.has('trending') && (
          <div hidden={active !== 'trending'}>
            <TrendingFeed />
          </div>
        )}

        {hydrated && visitedTabs.has('main') && (
          <div hidden={active !== 'main'}>
            <MainFeed />
          </div>
        )}

        {hydrated && visitedTabs.has('roster') && (
          <div hidden={active !== 'roster'}>
            <ArtistsFeed />
          </div>
        )}
      </div>
    </div>
    </LazyMountCtx.Provider>
  )
}

// ─── artists feed ────────────────────────────────────────────────────────────

interface CreatorListLite {
  slug: string
  name: string
  addresses: string[]
  collection?: string
}

// One card per artist in the active creator list. Each list names *which*
// artists appear; its optional `collection` decides *which* moment represents
// each one — for the Kismet Casa Rome list that's the Rome collection. Lists
// with no collection fall back to each artist's most-collected mint anywhere.
// Either way the feed is deduped to a single card per artist and ordered by
// the list, with the view-profile CTA steering to each artist's profile.
function ArtistsFeed() {
  const lazy = useContext(LazyMountCtx)
  const [lists, setLists] = useState<CreatorListLite[]>([])
  const [activeSlugs, setActiveSlugs] = useState<Set<string>>(new Set())
  const [listsLoaded, setListsLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/creator-lists')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { lists?: CreatorListLite[] }) => {
        const next = Array.isArray(d.lists) ? d.lists : []
        setLists(next)
        // Start with the first list on; the rest toggle in from there.
        setActiveSlugs(next[0] ? new Set([next[0].slug]) : new Set())
      })
      .catch(() => {})
      .finally(() => setListsLoaded(true))
  }, [])

  // Toggle a list on/off. A list never toggles off if it's the last one on —
  // with a single list that makes its button permanently on, and with several
  // it guarantees the feed always has at least one roster to show.
  const toggle = (slug: string) =>
    setActiveSlugs((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) {
        if (next.size === 1) return prev
        next.delete(slug)
      } else {
        next.add(slug)
      }
      return next
    })

  const activeLists = lists.filter((l) => activeSlugs.has(l.slug))

  // No lists at all → empty state with curator hint.
  if (listsLoaded && lists.length === 0) {
    return (
      <div className="border border-line p-8 sm:p-16 text-center mt-4">
        <p className="text-sm font-mono text-muted">no artist lists yet</p>
        <p className="text-xs font-mono text-subtle mt-2">
          a curator can create one from their profile
        </p>
      </div>
    )
  }

  // The artists of every active list, in list order then within-list order,
  // deduped across lists so an artist on two lists still gets a single card.
  const unionAddresses: string[] = []
  const unionSeen = new Set<string>()
  for (const l of activeLists) {
    for (const a of l.addresses) {
      const lc = a.toLowerCase()
      if (!unionSeen.has(lc)) {
        unionSeen.add(lc)
        unionAddresses.push(lc)
      }
    }
  }

  // Restrict the feed to the union's artists, keep one moment each (the first
  // survivor of the feed's sort order — most-collected for the fallback, the
  // sole token for a collection-scoped list), then order by the union sequence.
  const filterToArtists = (items: Moment[]) => {
    const order = new Map(unionAddresses.map((a, i) => [a, i]))
    const seen = new Set<string>()
    const out: Moment[] = []
    for (const m of items) {
      const addr = m.creator?.address?.toLowerCase()
      if (!addr || !order.has(addr) || seen.has(addr)) continue
      seen.add(addr)
      out.push(m)
    }
    return out.sort(
      (a, b) =>
        (order.get(a.creator.address.toLowerCase()) ?? 0) -
        (order.get(b.creator.address.toLowerCase()) ?? 0),
    )
  }

  // A lone collection-scoped list keeps its per-collection mint (Rome list →
  // each artist's Rome piece). Any union of lists — or an address-only list —
  // pulls the listed artists' timelines sorted by collects, so the dedupe keeps
  // each one's most-collected (most popular) mint across all active lists.
  const soleCollection =
    activeLists.length === 1 ? activeLists[0].collection : undefined
  const apiUrl = soleCollection
    ? `/api/timeline?collection=${soleCollection}`
    : unionAddresses.length > 0
      ? `/api/timeline?creators=${unionAddresses.join(',')}&sort=trending`
      : null

  // Each list is a toggle button. With one list its button is permanently on,
  // serving as the feed's title/context (e.g. the artists who stayed at the
  // Kismet Casa Rome residence). With several, clicking toggles each on/off and
  // the feed unions every active roster.
  const header =
    lists.length > 0 ? (
      <div className="flex items-center gap-2 flex-wrap">
        {lists.map((l) => {
          const on = activeSlugs.has(l.slug)
          return (
            <button
              key={l.slug}
              onClick={() => toggle(l.slug)}
              aria-pressed={on}
              className={`text-[10px] font-mono px-2.5 py-1 border transition-colors ${
                on
                  ? 'border-ink text-ink'
                  : 'border-line text-muted hover:border-muted hover:text-dim'
              }`}
            >
              {l.name}
              <span className="ml-1.5 text-subtle">{l.addresses.length}</span>
            </button>
          )
        })}
      </div>
    ) : null

  // No active artists (every roster empty) → nothing to query.
  if (!apiUrl) {
    return (
      <div>
        {header && <div className="py-4">{header}</div>}
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">
            {activeLists.length > 0 ? 'no artists in this list yet' : 'select a list'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <PaginatedGrid<Moment>
      apiUrl={apiUrl}
      itemsKey="moments"
      getKey={(m) => `${m.address}-${m.token_id}`}
      lazy={lazy}
      pageLimit={feedPageLimit(lazy)}
      filter={filterToArtists}
      header={header}
      renderItem={(m, { index }) => (
        <MomentCard
          key={`${m.address}-${m.token_id}`}
          moment={m}
          profileCta
          priority={index < 3}
          isMobile={lazy}
        />
      )}
      empty={
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">no mints to show yet</p>
        </div>
      }
    />
  )
}
