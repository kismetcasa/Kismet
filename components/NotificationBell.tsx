'use client'

import { useEffect, useRef, useState } from 'react'
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

  useEffect(() => {
    if (!address) { setCount(0); return }
    let cancelled = false

    async function fetchCount() {
      try {
        const res = await fetch(`/api/notifications/unread?address=${address}`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled && typeof data.count === 'number') setCount(data.count)
      } catch {
        // Silent — stale count is fine
      }
    }

    fetchCount()
    const interval = setInterval(fetchCount, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [address])

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
    }).catch(() => {})
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
