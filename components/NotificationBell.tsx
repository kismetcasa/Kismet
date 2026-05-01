'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { NotificationPreview } from './NotificationPreview'

interface NotificationBellProps {
  address: string
}

const POLL_INTERVAL_MS = 30_000
const HOVER_CLOSE_DELAY_MS = 150

export function NotificationBell({ address }: NotificationBellProps) {
  const [count, setCount] = useState(0)
  const [hovered, setHovered] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchCount = useCallback(async () => {
    if (!address) return
    try {
      const res = await fetch(`/api/notifications/unread?address=${address}`)
      if (!res.ok) return
      const data = await res.json()
      if (typeof data.count === 'number') setCount(data.count)
    } catch {
      // Silent — stale count is fine
    }
  }, [address])

  // Poll only when tab is visible; re-fetch immediately on tab focus
  useEffect(() => {
    if (!address) { setCount(0); return }
    fetchCount()
    const interval = setInterval(() => {
      if (!document.hidden) fetchCount()
    }, POLL_INTERVAL_MS)

    const onVisibilityChange = () => { if (!document.hidden) fetchCount() }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [address, fetchCount])

  // Listen for read signals from elsewhere in the app
  // - notif-read: mark-all-read fired → clear immediately
  // - notif-refetch: a single notification was read → re-verify count
  useEffect(() => {
    const onReadAll = () => setCount(0)
    const onRefetch = () => fetchCount()
    window.addEventListener('kismetart:notif-read', onReadAll)
    window.addEventListener('kismetart:notif-refetch', onRefetch)
    return () => {
      window.removeEventListener('kismetart:notif-read', onReadAll)
      window.removeEventListener('kismetart:notif-refetch', onRefetch)
    }
  }, [fetchCount])

  function handleEnter() {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setHovered(true)
  }

  function handleLeave() {
    closeTimer.current = setTimeout(() => setHovered(false), HOVER_CLOSE_DELAY_MS)
  }

  function handleRowClick(id: string) {
    setHovered(false)
    fetch('/api/notifications/read', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, id }),
    })
      .then(() => fetchCount())
      .catch(() => {})
  }

  const badge = count > 9 ? '9+' : String(count)

  return (
    <div
      className="relative h-14 flex items-center"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <Link
        href={`/profile/${address}?tab=notifications`}
        className="relative text-[#888] hover:text-[#efefef] transition-colors p-1"
        aria-label="Notifications"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-[#8B5CF6] text-[9px] font-mono text-white flex items-center justify-center leading-none">
            {badge}
          </span>
        )}
      </Link>

      <NotificationPreview address={address} visible={hovered} onRowClick={handleRowClick} />
    </div>
  )
}
