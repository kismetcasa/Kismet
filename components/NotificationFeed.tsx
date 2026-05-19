'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { NotificationRow } from './NotificationRow'
import { useUploadSession } from '@/hooks/useUploadSession'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { humanError } from '@/lib/toast'
import { NON_MUTEABLE_TYPES, type Notification, type NotificationType } from '@/lib/notifications'

type TypeFilter = 'all' | NotificationType

const PAGE_LIMIT = 20

// 'all' is pinned leftmost and not draggable; the rest of the filters are
// reorderable so users can put the types they care about up front.
const DRAGGABLE_FILTERS: NotificationType[] = [
  'collect',
  'sale',
  'follow',
  'mint',
  'airdrop',
  'listing_created',
  'listing_expired',
  'payout',
  'authorized',
]

const FILTER_LABEL: Record<TypeFilter, string> = {
  all: 'all',
  collect: 'collects',
  sale: 'sales',
  follow: 'follows',
  mint: 'mints',
  airdrop: 'airdrops',
  listing_created: 'listings',
  listing_expired: 'expired',
  payout: 'payouts',
  authorized: 'authorized',
}

const ORDER_KEY = 'kismetart:notif-tab-order'

// Reconcile a stored order against the current DRAGGABLE_FILTERS list: keep
// recognized entries in their saved positions, drop unknowns, append any
// newly-added filters at the end. Mirrors loadOrder() on the discover page.
function loadOrder(): NotificationType[] {
  if (typeof window === 'undefined') return DRAGGABLE_FILTERS
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (!raw) return DRAGGABLE_FILTERS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DRAGGABLE_FILTERS
    const valid = parsed.filter(
      (t): t is NotificationType =>
        typeof t === 'string' && (DRAGGABLE_FILTERS as readonly string[]).includes(t),
    )
    const missing = DRAGGABLE_FILTERS.filter((t) => !valid.includes(t))
    return [...valid, ...missing]
  } catch {
    return DRAGGABLE_FILTERS
  }
}

const POLL_INTERVAL_MS = 30_000
// Drag thresholds — see DiscoverPage/ProfileView for the matching tab
// and section drag patterns. Keep these in sync; long-press feel
// shouldn't differ between reorderable surfaces.
const NOTIF_LONG_PRESS_MS = 250
const NOTIF_SCROLL_INTENT_PX = 8
const NOTIF_MOUSE_DRAG_THRESHOLD_PX = 5

interface FilterDragState {
  pointerId: number
  startFilter: NotificationType
  startX: number
  startY: number
  anchorX: number
  longPressTimer: number | null
  phase: 'pending' | 'dragging'
}

export function NotificationFeed() {
  const { ensureSession } = useUploadSession()
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [filterOrder, setFilterOrder] = useState<NotificationType[]>(() => loadOrder())
  const filterOrderRef = useRef(filterOrder)
  filterOrderRef.current = filterOrder
  // Pointer-events drag state. Mirrors the tab-bar pattern: a "pending"
  // window after pointerdown that either commits to drag (long-press
  // on touch / 5px movement on mouse) or resolves as a tap. HTML5
  // draggable was avoided here for the same reason as the discover
  // tab bar — it hijacks tap-and-hold on touch and breaks the click
  // path that switches filters.
  const filterContainerRef = useRef<HTMLDivElement>(null)
  const filterDragRef = useRef<FilterDragState | null>(null)
  const [draggingFilter, setDraggingFilter] = useState<NotificationType | null>(null)
  const [filterDragOffsetX, setFilterDragOffsetX] = useState(0)
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Notification[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [fetchError, setFetchError] = useState(false)
  // Map of address (lowercased) → display name. NotificationRow keys off
  // each notification's actor; we batch-resolve them per page so the row
  // can render @username instead of 0x123…abc without N HTTP requests.
  const [actorNames, setActorNames] = useState<Record<string, string>>({})
  const sentinelRef = useRef<HTMLDivElement>(null)

  function handleReorder(next: NotificationType[]) {
    setFilterOrder(next)
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)) } catch {}
  }

  // ─── filter drag (long-press on touch, immediate on mouse) ────────────────

  function startFilterDrag() {
    const state = filterDragRef.current
    if (!state) return
    state.phase = 'dragging'
    setDraggingFilter(state.startFilter)
    if ('vibrate' in navigator) {
      try { navigator.vibrate(10) } catch {}
    }
  }

  function endFilterDrag(asTap: boolean) {
    const state = filterDragRef.current
    if (!state) return
    if (state.longPressTimer) clearTimeout(state.longPressTimer)
    if (asTap && state.phase === 'pending') setTypeFilter(state.startFilter)
    setDraggingFilter(null)
    setFilterDragOffsetX(0)
    filterDragRef.current = null
  }

  function handleFilterPointerDown(e: React.PointerEvent<HTMLButtonElement>, filter: NotificationType) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    filterDragRef.current = {
      pointerId: e.pointerId,
      startFilter: filter,
      startX: e.clientX,
      startY: e.clientY,
      anchorX: e.clientX,
      longPressTimer: e.pointerType === 'touch'
        ? window.setTimeout(startFilterDrag, NOTIF_LONG_PRESS_MS)
        : null,
      phase: 'pending',
    }
  }

  function handleFilterPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const state = filterDragRef.current
    if (!state || e.pointerId !== state.pointerId) return

    if (state.phase === 'pending') {
      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      if (e.pointerType === 'touch') {
        // Pre-commit movement → user is scrolling the filter row
        // horizontally or the page vertically. Bail so the browser
        // owns the gesture.
        if (Math.abs(dx) > NOTIF_SCROLL_INTENT_PX || Math.abs(dy) > NOTIF_SCROLL_INTENT_PX) {
          if (state.longPressTimer) clearTimeout(state.longPressTimer)
          filterDragRef.current = null
        }
        return
      }
      if (Math.abs(dx) < NOTIF_MOUSE_DRAG_THRESHOLD_PX && Math.abs(dy) < NOTIF_MOUSE_DRAG_THRESHOLD_PX) return
      startFilterDrag()
    }

    if (state.phase !== 'dragging') return
    e.preventDefault()
    setFilterDragOffsetX(e.clientX - state.anchorX)

    // Find the target draggable filter by midpoint crossing. 'all' is
    // pinned at index 0 in the rendered tabs and is excluded from the
    // sortable range here.
    const container = filterContainerRef.current
    if (!container) return
    const draggableEls = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-filter][data-draggable="true"]'),
    )
    const currentOrder = filterOrderRef.current
    const currentIdx = currentOrder.indexOf(state.startFilter)
    if (currentIdx < 0) return
    let targetIdx = currentIdx
    for (let i = 0; i < draggableEls.length; i++) {
      const rect = draggableEls[i].getBoundingClientRect()
      const center = rect.left + rect.width / 2
      if (e.clientX < center) { targetIdx = i; break }
      targetIdx = i
    }
    if (targetIdx !== currentIdx) {
      const next = [...currentOrder]
      const [moved] = next.splice(currentIdx, 1)
      next.splice(targetIdx, 0, moved)
      handleReorder(next)
      state.anchorX = e.clientX
      setFilterDragOffsetX(0)
    }
  }

  function handleFilterPointerEnd(e: React.PointerEvent<HTMLButtonElement>) {
    if (!filterDragRef.current || e.pointerId !== filterDragRef.current.pointerId) return
    endFilterDrag(/* asTap */ true)
  }

  function handleFilterPointerCancel(e: React.PointerEvent<HTMLButtonElement>) {
    if (!filterDragRef.current || e.pointerId !== filterDragRef.current.pointerId) return
    endFilterDrag(/* asTap */ false)
  }

  const hasMore = items.length < total

  // Reset + re-fetch when the type filter changes.
  useEffect(() => {
    setPage(1)
    setItems([])
    setTotal(0)
    setAuthRequired(false)
    setFetchError(false)
  }, [typeFilter])

  const fetchPage = useCallback(async (targetPage: number, signal?: AbortSignal): Promise<void> => {
    if (targetPage === 1) setLoading(true)
    else setLoadingMore(true)

    const params = new URLSearchParams({
      tab: 'all',
      page: String(targetPage),
      limit: String(PAGE_LIMIT),
    })
    if (typeFilter !== 'all') params.set('type', typeFilter)

    try {
      const r = await fetch(`/api/notifications?${params.toString()}`, {
        credentials: 'same-origin',
        signal,
      })
      if (r.status === 401) { setAuthRequired(true); setLoading(false); setLoadingMore(false); return }
      if (!r.ok) { if (targetPage === 1) setFetchError(true); return }
      const data = await r.json()
      if (signal?.aborted) return
      setFetchError(false)
      const newItems: Notification[] = data.notifications ?? []
      setItems((prev) => (targetPage === 1 ? newItems : [...prev, ...newItems]))
      setTotal(data.total ?? 0)
    } catch {
      if (signal?.aborted) return
      if (targetPage === 1) { setFetchError(true); setItems([]); setTotal(0) }
    } finally {
      if (!signal?.aborted) { setLoading(false); setLoadingMore(false) }
    }
  }, [typeFilter])

  // Fetch page — replaces on page 1, appends on page > 1
  useEffect(() => {
    const controller = new AbortController()
    fetchPage(page, controller.signal)
    return () => controller.abort()
  }, [page, fetchPage])

  // Live refresh while the modal is open: re-poll the first page every 30s
  // (only when the tab is visible) so new notifications surface without
  // requiring the user to close + reopen the modal. Mirrors the bell's
  // visibility-aware polling pattern.
  useEffect(() => {
    if (page !== 1) return
    const tick = () => { if (!document.hidden) fetchPage(1) }
    const interval = setInterval(tick, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [page, fetchPage])

  // Batch-resolve actor display names for the current page. Drives the
  // "@username" rendering in NotificationRow; falls back to shortAddress
  // when the actor doesn't have a profile. profileCache memoizes results
  // so this is cheap on subsequent pages.
  useEffect(() => {
    let cancelled = false
    const unresolved = Array.from(
      new Set(
        items
          .map((n) => n.actor?.toLowerCase())
          .filter((a): a is string => !!a && !(a in actorNames)),
      ),
    )
    if (unresolved.length === 0) return
    void Promise.all(unresolved.map((a) => fetchCreatorProfile(a))).then((profiles) => {
      if (cancelled) return
      setActorNames((prev) => {
        const next = { ...prev }
        for (let i = 0; i < unresolved.length; i++) {
          next[unresolved[i]] = profiles[i].name
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [items, actorNames])

  // Infinite scroll sentinel
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasMore || loading || loadingMore) return
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) setPage((p) => p + 1) },
      { threshold: 0.1 },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loading, loadingMore])

  async function handleMarkAllRead() {
    try {
      await ensureSession()
      await fetch('/api/notifications/read', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      setItems((prev) => prev.map((n) => ({ ...n, read: true })))
      window.dispatchEvent(new CustomEvent('kismetart:notif-read'))
    } catch (err) {
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Mark-read failed', { description })
    }
  }

  async function handleRowClick(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    try {
      await ensureSession()
      await fetch('/api/notifications/read', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      window.dispatchEvent(new CustomEvent('kismetart:notif-refetch'))
    } catch {
      // Optimistic UI already flipped; tolerate failure quietly so the
      // navigation onClick doesn't get blocked by a sign-in toast.
    }
  }

  async function handleMute(actor: string) {
    const lower = actor.toLowerCase()
    setItems((prev) => {
      // Only remove rows the server will actually hide — financial types
      // bypass actor-mute, so leaving them in avoids a refetch flicker.
      const removed = prev.filter(
        (n) => n.actor?.toLowerCase() === lower && !NON_MUTEABLE_TYPES.has(n.type),
      ).length
      if (removed > 0) setTotal((t) => Math.max(0, t - removed))
      return prev.filter(
        (n) => n.actor?.toLowerCase() !== lower || NON_MUTEABLE_TYPES.has(n.type),
      )
    })
    try {
      await ensureSession()
      await fetch('/api/notifications/mute', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor }),
      })
      window.dispatchEvent(new CustomEvent('kismetart:notif-refetch'))
    } catch (err) {
      const description = humanError(err)
      if (description === 'Cancelled') return
      toast.error('Mute failed', { description })
    }
  }

  // 'all' is pinned at index 0; subsequent entries are draggable.
  const tabs: TypeFilter[] = ['all', ...filterOrder]

  return (
    <div className="flex flex-col">
      {/* Type filters (long-press to reorder) + mark-all-read */}
      <div ref={filterContainerRef} className="flex items-center gap-2 px-1 py-2 border-b border-line overflow-x-auto">
        <div className="flex gap-1 flex-1">
          {tabs.map((tab) => {
            const isDraggable = tab !== 'all'
            const isActive = typeFilter === tab
            const isDragging = isDraggable && draggingFilter === tab
            return (
              <button
                key={tab}
                data-filter={tab}
                data-draggable={isDraggable ? 'true' : 'false'}
                onPointerDown={isDraggable ? (e) => handleFilterPointerDown(e, tab as NotificationType) : undefined}
                onPointerMove={isDraggable ? handleFilterPointerMove : undefined}
                onPointerUp={isDraggable ? handleFilterPointerEnd : undefined}
                onPointerCancel={isDraggable ? handleFilterPointerCancel : undefined}
                // 'all' is not reorderable — keep the click path. Reorderable
                // tabs fire setTypeFilter from handleFilterPointerEnd when
                // the gesture resolves as a tap, so onClick is omitted to
                // avoid racing the pointer-tap path on touch's synthetic click.
                onClick={isDraggable ? undefined : () => setTypeFilter(tab)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setTypeFilter(tab)
                  }
                }}
                style={isDragging
                  ? { transform: `translateX(${filterDragOffsetX}px)`, zIndex: 10, touchAction: 'none' }
                  : undefined}
                className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 border flex-shrink-0 select-none transition-colors duration-150 ${
                  isActive
                    ? 'border-accent text-accent'
                    : 'border-line text-muted hover:border-[#444] hover:text-dim'
                } ${isDraggable ? 'cursor-grab active:cursor-grabbing' : ''} ${
                  isDragging ? 'opacity-70' : ''
                }`}
              >
                {FILTER_LABEL[tab]}
              </button>
            )
          })}
        </div>
        <button
          onClick={handleMarkAllRead}
          className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors flex-shrink-0"
        >
          mark all read
        </button>
      </div>

      {/* List */}
      <div className="flex flex-col">
        {authRequired && (
          <p className="text-xs font-mono text-muted text-center py-12">
            sign in to see notifications
          </p>
        )}
        {!authRequired && fetchError && (
          <p className="text-xs font-mono text-muted text-center py-12">
            failed to load — try again
          </p>
        )}
        {!authRequired && !fetchError && loading && items.length === 0 && (
          <div className="flex justify-center py-12">
            <Loader2 size={16} className="animate-spin text-muted" />
          </div>
        )}
        {!authRequired && !fetchError && !loading && items.length === 0 && (
          <p className="text-xs font-mono text-muted text-center py-12">
            {typeFilter === 'all' ? 'no notifications yet' : 'nothing here yet'}
          </p>
        )}
        {items.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            actorName={n.actor ? actorNames[n.actor.toLowerCase()] : undefined}
            onClick={() => handleRowClick(n.id)}
            // Financial rows bypass actor-mute server-side; hiding the
            // button on them avoids "I muted them, why is this still here?"
            onMute={NON_MUTEABLE_TYPES.has(n.type) ? undefined : handleMute}
          />
        ))}
      </div>

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} className="flex justify-center py-4">
        {loadingMore && <Loader2 size={14} className="animate-spin text-muted" />}
      </div>
    </div>
  )
}
