'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { NotificationRow } from './NotificationRow'
import type { Notification, NotificationType } from '@/lib/notifications'

interface NotificationFeedProps {
  address: string
}

type Tab = 'priority' | 'all'
type TypeFilter = 'all' | NotificationType

const PAGE_LIMIT = 20

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'collect', label: 'collects' },
  { value: 'sale', label: 'sales' },
  { value: 'follow', label: 'follows' },
  { value: 'mint', label: 'mints' },
]

export function NotificationFeed({ address }: NotificationFeedProps) {
  const [tab, setTab] = useState<Tab>('priority')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Notification[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({
      address,
      tab,
      page: String(page),
      limit: String(PAGE_LIMIT),
    })
    if (typeFilter !== 'all') params.set('type', typeFilter)

    fetch(`/api/notifications?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        setItems(data.notifications ?? [])
        setTotal(data.total ?? 0)
      })
      .catch(() => {
        if (!cancelled) { setItems([]); setTotal(0) }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [address, tab, typeFilter, page])

  // Reset page when tab or filter changes
  useEffect(() => { setPage(1) }, [tab, typeFilter])

  async function handleMarkAllRead() {
    try {
      await fetch('/api/notifications/read', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, all: true }),
      })
      setItems((prev) => prev.map((n) => ({ ...n, read: true })))
    } catch {
      // Silent
    }
  }

  function handleRowClick(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)))
    fetch('/api/notifications/read', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, id }),
    }).catch(() => {})
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT))

  return (
    <div className="flex flex-col">
      {/* Header: tabs + mark all read */}
      <div className="flex items-center justify-between border-b border-[#2a2a2a] px-1 pb-2">
        <div className="flex gap-4">
          {(['priority', 'all'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs font-mono tracking-wider uppercase transition-colors ${
                tab === t ? 'text-[#efefef]' : 'text-[#555] hover:text-[#888]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          onClick={handleMarkAllRead}
          className="text-[10px] font-mono uppercase tracking-widest text-[#555] hover:text-[#efefef] transition-colors"
        >
          mark all read
        </button>
      </div>

      {/* Type filters */}
      <div className="flex gap-1 px-1 py-3 overflow-x-auto">
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

      {/* List */}
      <div className="flex flex-col">
        {loading && items.length === 0 && (
          <div className="flex justify-center py-12">
            <Loader2 size={16} className="animate-spin text-[#555]" />
          </div>
        )}
        {!loading && items.length === 0 && (
          <p className="text-xs font-mono text-[#555] text-center py-12">
            {tab === 'priority' ? 'nothing important yet' : 'no notifications yet'}
          </p>
        )}
        {items.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            onClick={() => handleRowClick(n.id)}
          />
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-[#2a2a2a] mt-4 pt-3 px-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="text-[10px] font-mono uppercase tracking-widest text-[#555] hover:text-[#efefef] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ← prev
          </button>
          <span className="text-[10px] font-mono text-[#555]">
            page {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="text-[10px] font-mono uppercase tracking-widest text-[#555] hover:text-[#efefef] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            next →
          </button>
        </div>
      )}
    </div>
  )
}
