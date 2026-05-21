'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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

  useEffect(() => {
    setModalOpen(false)
  }, [pathname])

  const fetchCount = useCallback(async () => {
    if (!address) return
    try {
      const res = await fetch('/api/notifications/unread', { credentials: 'same-origin' })
      // On 401 the session has expired — clear the stale badge so it doesn't
      // show a phantom count while the feed shows "sign in to see notifications".
      if (res.status === 401) { setCount(0); return }
      if (!res.ok) return
      const data = await res.json()
      if (typeof data.count === 'number') setCount(data.count)
    } catch {
      // Silent — stale count is fine on network errors
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

  // Opening the panel implies "I've seen these" — clear the badge
  // immediately and mark everything read on the server as a fire-and-
  // forget. If the session isn't valid the request 401s and the next
  // poll restores the real count, which is the right fallback.
  function openPanel() {
    setModalOpen(true)
    if (count > 0) {
      setCount(0)
      void fetch('/api/notifications/read', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
        .then((r) => {
          if (r.ok) {
            // Tell any mounted feed to flip its rows to read so the
            // unread styling clears alongside the badge.
            window.dispatchEvent(new CustomEvent('kismetart:notif-read'))
          }
        })
        .catch(() => {})
    }
  }

  return (
    <div className="relative h-14 flex items-center">
      <button
        onClick={() => (modalOpen ? setModalOpen(false) : openPanel())}
        // min-w/h-10 (40px) enforces a near-iOS-HIG touch target around
        // the 18px Bell — p-1 alone gave a ~26px tappable region that
        // missed often on mobile.
        className="relative text-dim hover:text-ink transition-colors flex items-center justify-center min-w-10 min-h-10"
        aria-label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
      >
        <Bell size={18} />
        {count > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-accent text-[9px] font-mono text-surface flex items-center justify-center leading-none"
          >
            {badge}
          </span>
        )}
      </button>

      {modalOpen && createPortal(
        <NotificationModal onClose={() => setModalOpen(false)} />,
        document.body,
      )}
    </div>
  )
}
