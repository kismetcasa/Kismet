'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Bell } from 'lucide-react'
import { NotificationModal } from './NotificationModal'

interface NotificationBellProps {
  address: string
}

const POLL_INTERVAL_MS = 30_000

export function NotificationBell({ address }: NotificationBellProps) {
  const pathname = usePathname()
  const [count, setCount] = useState(0)
  const [modalOpen, setModalOpen] = useState(false)

  // Close modal when navigating to a new page
  useEffect(() => {
    setModalOpen(false)
  }, [pathname])

  const fetchCount = useCallback(async () => {
    if (!address) return
    try {
      // Cookie-authenticated: returns 401 before sign-in (count stays 0)
      // and counts the session owner's unread once they're signed in.
      const res = await fetch('/api/notifications/unread', { credentials: 'same-origin' })
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

  // Listen for read signals from notification feed
  // - notif-read: mark-all-read fired → clear badge immediately
  // - notif-refetch: single notification read or mute → re-verify count
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

  const badge = count > 9 ? '9+' : String(count)

  return (
    <div className="relative h-14 flex items-center">
      <button
        onClick={() => setModalOpen((v) => !v)}
        className="relative text-[#888] hover:text-[#efefef] transition-colors p-1"
        aria-label="Notifications"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-[#8B5CF6] text-[9px] font-mono text-white flex items-center justify-center leading-none">
            {badge}
          </span>
        )}
      </button>

      {modalOpen && (
        <NotificationModal
          address={address}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}
