'use client'

import { createContext, useContext, useState, useEffect, useRef, useCallback, startTransition } from 'react'
import { useAccount } from 'wagmi'
import { MomentCard } from '@/components/MomentCard'
import { CollectionCard, type CollectionDisplay } from '@/components/CollectionCard'
import { FeaturedFeed } from '@/components/FeaturedFeed'
import { PaginatedGrid } from '@/components/PaginatedGrid'
import { ViewModeToggle } from '@/components/ViewModeToggle'
import { useViewMode } from '@/hooks/useViewMode'
import { useLongPressDrag } from '@/hooks/useLongPressDrag'
import type { Moment } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'
import { KISMET_CASA_ROME_COLLECTION } from '@/lib/config'

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
}: {
  order: TabId[]
  active: TabId
  onSelect: (t: TabId) => void
  onReorder: (o: TabId[]) => void
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
              ${isActive ? 'text-ink' : 'text-[#444] hover:text-dim'}
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
      // Smaller page on mobile: fewer cards mounted per fetch means
      // less initial fiber/decode/multicall work on the iframe's
      // constrained connection pool. Desktop has capacity for 18.
      pageLimit={lazy ? 12 : 18}
      renderItem={(m, { index }) => (
        <MomentCard
          key={`${m.address}-${m.token_id}`}
          moment={m}
          compact={isGrid}
          showCreator={isGrid}
          priority={index < eagerCount}
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
      pageLimit={lazy ? 12 : 18}
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
            subTab === 'mints' ? 'text-ink' : 'text-[#444] hover:text-dim'
          }`}
        >
          mints
        </button>
        <span className="text-xs font-mono text-line select-none">/</span>
        <button
          onClick={() => setSubTab('collections')}
          className={`text-xs font-mono tracking-wider transition-colors ${
            subTab === 'collections' ? 'text-ink' : 'text-[#444] hover:text-dim'
          }`}
        >
          collections
        </button>
      </div>
      {address && (
        <button
          onClick={() => setFollowingOn((v) => !v)}
          className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 border transition-colors ${
            followingOn
              ? 'border-accent text-accent'
              : 'border-line text-muted hover:border-[#444] hover:text-dim'
          }`}
        >
          following
        </button>
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

export function DiscoverPage({ isMobile }: { isMobile: boolean }) {
  const { isAdmin, hasSession, startSession, featuredKeys, featuredCollectionAddrs } = useAdmin()
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
      />

      <div className="mt-2">
        {!hydrated && (
          <div className="py-8 text-center text-xs font-mono text-muted">loading…</div>
        )}
        {hydrated && visitedTabs.has('featured') && (
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
              // Content-derived key so swapping a feature (un-feature A,
              // feature B in the same session) still triggers a re-fetch.
              // `.size` alone wouldn't change in that case.
              key={`featured-${[...featuredCollectionAddrs].join(',')}-${[...featuredKeys].join(',')}`}
              emptyMessage={isAdmin ? 'no featured mints or collections yet — click ★ on any mint or collection to feature it' : 'no featured mints or collections yet'}
              isMobile={isMobile}
            />
          </div>
        )}

        {hydrated && visitedTabs.has('trending') && (
          <div hidden={active !== 'trending'}>
            <MomentFeed
              apiUrl="/api/timeline?sort=trending&scope=standalone"
              emptyMessage="no collects recorded yet — trending appears as mints are collected"
              withViewToggle
            />
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

// One card per artist who minted into the Kismet Casa Rome collection. The
// collection holds a single piece per artist, so scoping the timeline to it
// and deduping by creator yields exactly that artist's Rome mint. Each card
// pairs a "view profile" link with the standard collect action.
function ArtistsFeed() {
  const lazy = useContext(LazyMountCtx)

  // Dedupe by creator, keeping the first (newest) moment per address. Guards
  // against an artist who minted more than one piece into the collection.
  const dedupeByArtist = useCallback((items: Moment[]) => {
    const seen = new Set<string>()
    return items.filter((m) => {
      const addr = m.creator?.address?.toLowerCase()
      if (!addr || seen.has(addr)) return false
      seen.add(addr)
      return true
    })
  }, [])

  return (
    <PaginatedGrid<Moment>
      apiUrl={`/api/timeline?collection=${KISMET_CASA_ROME_COLLECTION}`}
      itemsKey="moments"
      getKey={(m) => `${m.address}-${m.token_id}`}
      lazy={lazy}
      pageLimit={lazy ? 12 : 18}
      filter={dedupeByArtist}
      renderItem={(m, { index }) => (
        <MomentCard
          key={`${m.address}-${m.token_id}`}
          moment={m}
          profileCta
          priority={index < 3}
        />
      )}
      empty={
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">no artists yet</p>
        </div>
      }
    />
  )
}
