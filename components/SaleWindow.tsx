'use client'

import { useEffect, useState } from 'react'
import { Clock } from 'lucide-react'
import { getSaleWindow, formatSaleWindowLabel } from '@/lib/inprocess'

interface SaleWindowProps {
  /** The moment's sale config (saleStart/saleEnd unix-second strings). */
  saleConfig: { saleStart?: string; saleEnd?: string } | null | undefined
  /** `detail` = roomy collect page (includes the timezone); `card` = compact
   *  feed/grid badge (no zone, and date-only when also `compact`). */
  variant?: 'card' | 'detail'
  /** Compact grid card — smaller type + drops the time (tap through for it). */
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
    // Compact cards show the date only — the full time + zone lives one tap
    // away on the detail page, and a time would truncate at card width.
    withTime: !(variant === 'card' && compact),
    withTimeZone: variant === 'detail',
  })
  if (!label) return null

  // Ended is spent — render it fainter than an upcoming/active window.
  const ended = info.state === 'ended'
  const tone = ended ? (variant === 'detail' ? 'text-[#444]' : 'text-faint') : 'text-dim'
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
