'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { getSaleWindow, formatSaleWindowLabel } from '@/lib/inprocess'

interface SaleWindowProps {
  /** The moment's sale config (saleStart/saleEnd unix-second strings). */
  saleConfig: { saleStart?: string; saleEnd?: string } | null | undefined
  /** `detail` = roomy collect page (full time + timezone); `card` = feed/grid
   *  badge (date-only, no zone — the time lives one tap away on the detail). */
  variant?: 'card' | 'detail'
  /** Compact grid card — smaller type + icon (both card variants are date-only). */
  compact?: boolean
  /** Extra classes on the row wrapper (e.g. the detail page's padding). */
  className?: string
}

/**
 * Renders the absolute, viewer-local sale-window date a collector needs to know
 * WHEN a drop opens or closes — "Opens Jul 3, 3:00 PM" / "Sale ends Jul 8, 5:00 PM
 * EDT" / "Ended Jun 25" — the human-readable companion to the saleStart/saleEnd
 * button gating. Renders nothing for a live open-ended sale (no date) or a
 * moment with no sale config.
 *
 * CLIENT-ONLY by construction: the label is a locale/timezone-formatted date,
 * which would differ between the SSR pass (server timezone) and hydration
 * (viewer timezone). Returning null until mounted keeps the first client render
 * identical to the server's, then fills in the real viewer-local date on the
 * post-mount re-render — no hydration mismatch, no flash of a server-TZ time.
 */
export function SaleWindow({ saleConfig, variant = 'card', compact = false, className = '' }: SaleWindowProps) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null

  const info = getSaleWindow(saleConfig)
  if (!info) return null
  const label = formatSaleWindowLabel(info, {
    // Cards show the DATE ONLY ("Sale ends Jul 31") — the exact time + zone
    // lives one tap away on the detail page. A time crowds the card line (and
    // truncates outright on compact grid cards), and the day is the only part
    // a browsing collector needs at a glance.
    withTime: variant === 'detail',
    withTimeZone: variant === 'detail',
  })
  if (!label) return null

  // Ended is spent — render it fainter than an upcoming/active window.
  const ended = info.state === 'ended'
  const tone = ended ? (variant === 'detail' ? 'text-subtle' : 'text-subtle') : 'text-dim'
  const textSize = variant === 'card' && compact ? 'text-[9px]' : 'text-[10px]'
  const iconSize = variant === 'card' && compact ? 9 : 11
  const tracking = variant === 'detail' ? 'tracking-widest' : 'tracking-wider'

  return (
    <div className={`flex items-center gap-1.5 min-w-0 ${className}`}>
      <Clock size={iconSize} className={`flex-shrink-0 ${tone}`} />
      <span className={`${textSize} font-mono uppercase ${tracking} ${tone}${variant === 'card' ? ' truncate' : ' whitespace-nowrap'}`}>
        {label}
      </span>
    </div>
  )
}
