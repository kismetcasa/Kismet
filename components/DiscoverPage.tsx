'use client'

import { createContext, useContext, useState, useEffect, useRef, useCallback, startTransition } from 'react'
import { useAccount } from 'wagmi'
import { MomentCard } from '@/components/MomentCard'
import { CollectionCard, type CollectionDisplay } from '@/components/CollectionCard'
import { FeaturedFeed } from '@/components/FeaturedFeed'
import { PaginatedGrid } from '@/components/PaginatedGrid'
import { ViewModeToggle } from '@/components/ViewModeToggle'
import { useViewMode } from '@/hooks/useViewMode'
import type { Moment } from '@/lib/inprocess'
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

// Long-press threshold for touch-initiated drag. Matches iOS / common
// reorder UIs: 250ms is long enough that a deliberate hold registers
// as "I'm reorganizing" but short enough that it doesn't feel laggy.
const LONG_PRESS_MS = 250
// Movement during the "pending" window that disqualifies a hold from
// becoming a drag — the user is scrolling, not reordering.
const SCROLL_INTENT_PX = 8
// Mouse: skip the long-press entirely and pick up after this much
// pointer movement. Matches HTML5 native drag latency.
const MOUSE_DRAG_THRESHOLD_PX = 5

interface DragState {
  pointerId: number
  startTab: TabId
  // Tracks the pointer's last x in container coordinates so movement
  // calc stays correct after a reorder repositions the tab DOM.
  anchorX: number
  startX: number
  startY: number
  longPressTimer: number | null
  phase: 'pending' | 'dragging'
}

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
  const dragRef = useRef<DragState | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  // Re-render-triggering state only — `dragRef` holds the
  // high-frequency pointer data so move handlers don't thrash React.
  const [draggingTab, setDraggingTab] = useState<TabId | null>(null)
  const [dragOffsetX, setDragOffsetX] = useState(0)

  function startDrag() {
    if (!dragRef.current) return
    dragRef.current.phase = 'dragging'
    setDraggingTab(dragRef.current.startTab)
    // Best-effort haptic on devices that support it (Android Chrome,
    // some Firefox); ignored elsewhere. Matches the "you picked it up"
    // feel of the iOS Home-Screen edit mode.
    if ('vibrate' in navigator) {
      try { navigator.vibrate(10) } catch {}
    }
  }

  function endDrag(tapped: boolean) {
    const state = dragRef.current
    if (!state) return
    if (state.longPressTimer) clearTimeout(state.longPressTimer)
    if (tapped && state.phase === 'pending') onSelect(state.startTab)
    setDraggingTab(null)
    setDragOffsetX(0)
    dragRef.current = null
  }

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>, tab: TabId) {
    // Left mouse only — middle/right click should not initiate drag.
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // Capture so we still get move/up events if the pointer drifts off
    // the button's bounding box mid-drag.
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = {
      pointerId: e.pointerId,
      startTab: tab,
      anchorX: e.clientX,
      startX: e.clientX,
      startY: e.clientY,
      longPressTimer: e.pointerType === 'touch'
        ? window.setTimeout(startDrag, LONG_PRESS_MS)
        : null,
      phase: 'pending',
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const state = dragRef.current
    if (!state || e.pointerId !== state.pointerId) return

    if (state.phase === 'pending') {
      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      if (e.pointerType === 'touch') {
        // Movement before the long-press fires → user is scrolling.
        // Abandon so the browser can keep handling the scroll natively.
        if (Math.abs(dx) > SCROLL_INTENT_PX || Math.abs(dy) > SCROLL_INTENT_PX) {
          if (state.longPressTimer) clearTimeout(state.longPressTimer)
          dragRef.current = null
        }
        return
      }
      // Mouse: pick up after a small drag delta — feels instant to
      // users used to native HTML5 drag.
      if (Math.abs(dx) < MOUSE_DRAG_THRESHOLD_PX && Math.abs(dy) < MOUSE_DRAG_THRESHOLD_PX) return
      startDrag()
    }

    if (state.phase !== 'dragging') return
    // Block page scroll / pull-to-refresh while we own the gesture.
    e.preventDefault()

    setDragOffsetX(e.clientX - state.anchorX)

    // Reorder on midpoint crossing — instant swap, no animation. Our
    // visual anchor (the dragged tab's translateX) keeps the user's
    // finger over the moving element, so the snap reads as "the slot
    // moved under me" rather than "the tab teleported elsewhere".
    const container = containerRef.current
    if (!container) return
    const currentOrder = orderRef.current
    const currentIdx = currentOrder.indexOf(state.startTab)
    if (currentIdx < 0) return
    const tabEls = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-tab]'))
    let targetIdx = currentIdx
    for (let i = 0; i < tabEls.length; i++) {
      const rect = tabEls[i].getBoundingClientRect()
      const center = rect.left + rect.width / 2
      if (e.clientX < center) { targetIdx = i; break }
      targetIdx = i
    }
    if (targetIdx !== currentIdx) {
      const next = [...currentOrder]
      const [moved] = next.splice(currentIdx, 1)
      next.splice(targetIdx, 0, moved)
      onReorder(next)
      // Re-anchor so the offset visual stays small relative to the new
      // slot — without this, after one swap the tab visually races
      // way ahead of (or behind) the finger.
      state.anchorX = e.clientX
      setDragOffsetX(0)
    }
  }

  function handlePointerEnd(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragRef.current || e.pointerId !== dragRef.current.pointerId) return
    endDrag(/* tapped */ true)
  }

  function handlePointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    if (!dragRef.current || e.pointerId !== dragRef.current.pointerId) return
    endDrag(/* tapped */ false)
  }

  return (
    <div ref={containerRef} className="flex items-end gap-0 border-b border-line">
      {order.map((tab) => {
        const isActive = tab === active
        const isDragging = tab === draggingTab
        return (
          <button
            key={tab}
            data-tab={tab}
            onPointerDown={(e) => handlePointerDown(e, tab)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerCancel}
            // Keyboard activation — `<button>` would otherwise synthesize
            // a click on Enter/Space, but we deliberately don't bind
            // onClick (it would race the pointer-tap handler in
            // handlePointerEnd). Explicit handler keeps a11y intact.
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(tab)
              }
            }}
            // touch-action: pan-y pre-drag — the user can still scroll
            // the page past the tab bar by swiping vertically. Drag
            // commit (long-press fires) flips to touch-none so the
            // horizontal swap gesture isn't lost to the browser.
            style={isDragging
              ? { transform: `translateX(${dragOffsetX}px)`, zIndex: 10, touchAction: 'none' }
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

  // Hydrate from localStorage after mount. Order + last-active tab are
  // independent keys so reordering doesn't reset the active tab and vice
  // versa. If the saved active tab isn't in the (reconciled) order, fall
  // back to the leftmost tab — handled inside loadActiveTab.
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
        {hydrated && active === 'featured' && (
          <>
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
          </>
        )}

        {hydrated && active === 'trending' && (
          <MomentFeed
            apiUrl="/api/timeline?sort=trending&scope=standalone"
            emptyMessage="no collects recorded yet — trending appears as mints are collected"
            withViewToggle
          />
        )}

        {hydrated && active === 'main' && <MainFeed />}

        {hydrated && active === 'roster' && <RosterFeed />}
      </div>
    </div>
    </LazyMountCtx.Provider>
  )
}

// ─── roster feed ─────────────────────────────────────────────────────────────

interface CreatorListLite {
  slug: string
  name: string
  addresses: string[]
}

function RosterFeed() {
  const [lists, setLists] = useState<CreatorListLite[]>([])
  const [activeSlug, setActiveSlug] = useState<string | null>(null)
  const [listsLoaded, setListsLoaded] = useState(false)

  useEffect(() => {
    fetch('/api/creator-lists')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { lists?: CreatorListLite[] }) => {
        const next = Array.isArray(d.lists) ? d.lists : []
        setLists(next)
        setActiveSlug(next[0]?.slug ?? null)
      })
      .catch(() => {})
      .finally(() => setListsLoaded(true))
  }, [])

  const activeList = lists.find((l) => l.slug === activeSlug) ?? null

  // No lists at all → empty state with curator hint. Don't render
  // MomentFeed since there's nothing to query.
  if (listsLoaded && lists.length === 0) {
    return (
      <div className="border border-line p-8 sm:p-16 text-center mt-4">
        <p className="text-sm font-mono text-muted">
          no creator rosters yet
        </p>
        <p className="text-xs font-mono text-[#444] mt-2">
          a curator can create one from their profile
        </p>
      </div>
    )
  }

  // Empty list selected → don't fire the API call (?creators= would be
  // empty → match-nothing); show empty state inline.
  const apiUrl =
    activeList && activeList.addresses.length > 0
      ? `/api/timeline?creators=${activeList.addresses.join(',')}`
      : null

  const header = lists.length > 0 ? (
    <div className="flex items-center gap-2 flex-wrap">
      {lists.map((l) => (
        <button
          key={l.slug}
          onClick={() => setActiveSlug(l.slug)}
          className={`text-[10px] font-mono px-2.5 py-1 border transition-colors ${
            l.slug === activeSlug
              ? 'border-ink text-ink'
              : 'border-line text-muted hover:border-muted hover:text-dim'
          }`}
        >
          {l.name}
          <span className="ml-1.5 text-[#444]">{l.addresses.length}</span>
        </button>
      ))}
    </div>
  ) : null

  if (!apiUrl) {
    return (
      <div>
        <div className="py-4">{header}</div>
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">
            {activeList ? 'this list has no creators yet' : 'select a roster'}
          </p>
        </div>
      </div>
    )
  }

  return (
    <MomentFeed
      apiUrl={apiUrl}
      header={header}
      emptyMessage="no moments yet from this roster"
      withViewToggle
    />
  )
}
