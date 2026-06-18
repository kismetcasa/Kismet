'use client'

import { useEffect, useMemo, useState } from 'react'
import { formatEarningsValue, type EarningsMetric } from '@/lib/earningsFormat'

interface Stats {
  eth: number
  usdc: number
  usd: number
  mints: number
}

const DENOM_STORAGE_KEY = 'kismetart:earnings-denom'

// Public earnings strip on a profile: one tappable earnings figure that cycles
// ETH → USDC → USD — only through denominations the artist actually has, plus
// the blended USD — with the paid-mint count underneath. Native ETH/USDC are
// the stable truth; USD is the live market-value lens. Hidden entirely until the
// artist has a paid sale, so new profiles stay clean.
export function ProfileStats({ address }: { address: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [denom, setDenom] = useState<EarningsMetric>('usd')

  useEffect(() => {
    let cancelled = false
    fetch(`/api/stats?artist=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setStats({ eth: d.eth ?? 0, usdc: d.usdc ?? 0, usd: d.usd ?? 0, mints: d.mints ?? 0 })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address])

  // Restore the viewer's last-used denomination preference.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DENOM_STORAGE_KEY)
      if (saved === 'eth' || saved === 'usdc' || saved === 'usd') setDenom(saved)
    } catch {}
  }, [])

  // Offer only denominations the artist earned in, plus USD (the blend) whenever
  // there's any earning — so the cycle never lands on a dead "0 USDC".
  const available = useMemo<EarningsMetric[]>(() => {
    if (!stats) return []
    const a: EarningsMetric[] = []
    if (stats.eth > 0) a.push('eth')
    if (stats.usdc > 0) a.push('usdc')
    if (stats.eth > 0 || stats.usdc > 0) a.push('usd')
    return a
  }, [stats])

  if (!stats || stats.mints <= 0 || available.length === 0) return null

  const active = available.includes(denom) ? denom : available[0]
  const cycle = () => {
    const next = available[(available.indexOf(active) + 1) % available.length]
    setDenom(next)
    try {
      localStorage.setItem(DENOM_STORAGE_KEY, next)
    } catch {}
  }

  const multi = available.length > 1
  return (
    <div className="mt-3">
      <button
        onClick={multi ? cycle : undefined}
        className={`font-mono text-ink text-xl leading-tight ${
          multi ? 'cursor-pointer hover:text-accent transition-colors' : 'cursor-default'
        }`}
        title={multi ? 'Tap to switch currency' : undefined}
      >
        {formatEarningsValue(active, stats)}
      </button>
      <p className="font-mono text-muted text-xs mt-0.5">
        {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'}
      </p>
    </div>
  )
}
