'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { NotificationRow } from './NotificationRow'
import type { Notification } from '@/lib/notifications'

interface NotificationPreviewProps {
  address: string
  visible: boolean
  onRowClick?: (id: string) => void
  onSeeAll?: () => void
}

const PREVIEW_LIMIT = 5

export function NotificationPreview({ address, visible, onRowClick, onSeeAll }: NotificationPreviewProps) {
  const [items, setItems] = useState<Notification[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!visible || !address) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/notifications?address=${address}&limit=${PREVIEW_LIMIT}&page=1&tab=all`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        setItems((data.notifications ?? []).slice(0, PREVIEW_LIMIT))
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [visible, address])

  function handleMute(actor: string) {
    const lower = actor.toLowerCase()
    setItems((prev) => (prev ?? []).filter((n) => n.actor?.toLowerCase() !== lower))
    fetch('/api/notifications/mute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, actor }),
    })
      .then(() => window.dispatchEvent(new CustomEvent('kismetart:notif-refetch')))
      .catch(() => {})
  }

  if (!visible) return null

  return (
    <div className="absolute top-full right-0 mt-1 w-80 bg-[#161616] border border-[#2a2a2a] z-[55] overflow-hidden">
      <div className="px-3 py-2 border-b border-[#2a2a2a] flex items-center justify-between">
        <p className="text-[9px] font-mono uppercase tracking-widest text-[#444]">notifications</p>
        {loading && <Loader2 size={11} className="text-[#555] animate-spin" />}
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        {items === null && !loading && (
          <p className="px-4 py-6 text-xs font-mono text-[#555] text-center">loading…</p>
        )}
        {items !== null && items.length === 0 && (
          <p className="px-4 py-6 text-xs font-mono text-[#555] text-center">nothing yet</p>
        )}
        {items !== null && items.map((n) => (
          <NotificationRow
            key={n.id}
            notification={n}
            compact
            onClick={() => onRowClick?.(n.id)}
            onMute={handleMute}
          />
        ))}
      </div>

      <button
        onClick={onSeeAll}
        className="block w-full border-t border-[#2a2a2a] px-3 py-2 text-[9px] font-mono uppercase tracking-widest text-[#555] hover:text-[#efefef] text-center transition-colors"
      >
        see all →
      </button>
    </div>
  )
}
