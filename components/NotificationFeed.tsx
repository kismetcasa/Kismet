'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { NotificationRow } from './NotificationRow'
import { useUploadSession } from '@/hooks/useUploadSession'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { humanError } from '@/lib/toast'
import type { Notification, NotificationType } from '@/lib/notifications'

export type FeedTab = 'notifications' | 'all' | 'following'
type Tab = 'priority' | 'all'
type TypeFilter = 'all' | NotificationType

const PAGE_LIMIT = 20

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'collect', label: 'collects' },
  { value: 'sale', label: 'sales' },
  { value: 'follow', label: 'follows' },
  { value: 'mint', label: 'mints' },
  { value: 'airdrop', label: 'airdrops' },
  { value: 'listing_expired', label: 'expired' },
]

const POLL_INTERVAL_MS = 30_000

interface NotificationFeedProps {
  feedTab: FeedTab
  followingAddrs?: string[]
}

export function NotificationFeed({ feedTab, followingAddrs }: NotificationFeedProps) {
  const { ensureSession } = useUploadSession()
  const apiTab: Tab = feedTab === 'notifications' ? 'priority' : 'all'
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
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

  const hasMore = items.length < total

  // Reset + re-fetch only when the API-level tab or type filter changes.
  // Switching between 'all' and 'following' (both use apiTab='all') does NOT
  // clear items — the following filter is applied client-side to existing data.
  useEffect(() => {
    setPage(1)
    setItems([])
    setTotal(0)
    setAuthRequired(false)
    setFetchError(false)
  }, [apiTab, typeFilter])

  const fetchPage = useCallback(async (targetPage: number, signal?: AbortSignal): Promise<void> => {
    if (targetPage === 1) setLoading(true)
    else setLoadingMore(true)

    const params = new URLSearchParams({
      tab: apiTab,
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
  }, [apiTab, typeFilter])

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
      const removed = prev.filter((n) => n.actor?.toLowerCase() === lower).length
      if (removed > 0) setTotal((t) => Math.max(0, t - removed))
      return prev.filter((n) => n.actor?.toLowerCase() !== lower)
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

  const displayItems = feedTab === 'following' && followingAddrs && followingAddrs.length > 0
    ? items.filter((n) => n.actor && followingAddrs.includes(n.actor.toLowerCase()))
    : items

  return (
    <div className="flex flex-col">
      {/* Type filters + mark-all-read */}
      <div className="flex items-center gap-2 px-1 py-2 border-b border-[#2a2a2a] overflow-x-auto">
        <div className="flex gap-1 flex-1">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setTypeFilter(f.value)}
              className={`text-[10px] font-mono uppercase tracking-widest px-2.5 py-1 border transition-colors flex-shrink-0 ${
                typeFilter === f.value
                  ? 'border-[#8B5CF6] text-[#8B5CF6]'
                  : 'border-[#2a2a2a] text-[#555] hover:border-[#444] hover:text-[#888]'
              }`}
            >
              {f.label}
            </button>
          ))}
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
        {!authRequired && !fetchError && !loading && displayItems.length === 0 && (
          <p className="text-xs font-mono text-[#555] text-center py-12">
            {feedTab === 'following' ? 'no activity from followed creators yet' : feedTab === 'notifications' ? 'nothing important yet' : 'no notifications yet'}
          </p>
        )}
        {displayItems.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            actorName={n.actor ? actorNames[n.actor.toLowerCase()] : undefined}
            onClick={() => handleRowClick(n.id)}
            onMute={handleMute}
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
