'use client'

import { useEffect, useState } from 'react'
import { formatRemaining } from '@/lib/drops'

/** Live "closes in …" text for a claim drop; ticks once a second. */
export function DropCountdown({ closesAt, className }: { closesAt: number; className?: string }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  const left = closesAt - now
  return <span className={className}>{left > 0 ? `closes in ${formatRemaining(left)}` : 'claims closed'}</span>
}
