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

export function NotificationFeed() {
  const { ensureSession } = useUploadSession()
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [filterOrder, setFilterOrder] = useState<NotificationType[]>(() => loadOrder())
  // Tracked by value (not index) so we don't need to bump state every swap.
  const [dragging, setDragging] = useState<NotificationType | null>(null)
  const dragIdx = useRef<number | null>(null)
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

  function onDragStart(value: NotificationType, idx: number) {
    dragIdx.current = idx
    setDragging(value)
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === idx) return
    const next = [...filterOrder]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(idx, 0, moved)
    dragIdx.current = idx
    handleReorder(next)
  }

  function onDragEnd() {
    dragIdx.current = null
    setDragging(null)
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
      {/* Type filters (drag to reorder) + mark-all-read */}
      <div className="flex items-center gap-2 px-1 py-2 border-b border-[#2a2a2a] overflow-x-auto">
        <div className="flex gap-1 flex-1">
          {tabs.map((tab, i) => {
            const draggable = i > 0
            const orderIdx = i - 1
            const isActive = typeFilter === tab
            const isDragging = draggable && dragging === tab
            return (
              <button
                key={tab}
                draggable={draggable}
                onDragStart={draggable ? () => onDragStart(tab as NotificationType, orderIdx) : undefined}
                onDragOver={draggable ? (e) => onDragOver(e, orderIdx) : undefined}
                onDragEnd={draggable ? onDragEnd : undefined}
                onClick={() => setTypeFilter(tab)}
                className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 border flex-shrink-0 select-none transition-all duration-150 ${
                  isActive
                    ? 'border-[#8B5CF6] text-[#8B5CF6]'
                    : 'border-[#2a2a2a] text-[#555] hover:border-[#444] hover:text-[#888]'
                } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''} ${
                  isDragging ? 'opacity-40' : ''
                }`}
              >
                {FILTER_LABEL[tab]}
              </button>
            )
          })}
        </div>
        <button
          onClick={handleMarkAllRead}
          className="text-[10px] font-mono uppercase tracking-widest text-[#555] hover:text-[#efefef] transition-colors flex-shrink-0"
        >
          mark all read
        </button>
      </div>

      {/* List */}
      <div className="flex flex-col">
        {authRequired && (
          <p className="text-xs font-mono text-[#555] text-center py-12">
            sign in to see notifications
          </p>
        )}
        {!authRequired && fetchError && (
          <p className="text-xs font-mono text-[#555] text-center py-12">
            failed to load — try again
          </p>
        )}
        {!authRequired && !fetchError && loading && items.length === 0 && (
          <div className="flex justify-center py-12">
            <Loader2 size={16} className="animate-spin text-[#555]" />
          </div>
        )}
        {!authRequired && !fetchError && !loading && items.length === 0 && (
          <p className="text-xs font-mono text-[#555] text-center py-12">
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
        {loadingMore && <Loader2 size={14} className="animate-spin text-[#555]" />}
      </div>
    </div>
  )
}
