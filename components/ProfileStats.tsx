'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pin } from 'lucide-react'
import { formatEarningsValue, type EarningsMetric } from '@/lib/earningsFormat'

interface Stats {
  eth: number
  usdc: number
  usd: number
  mints: number
  public: boolean
}

const DENOM_STORAGE_KEY = 'kismetart:earnings-denom'

// Earnings card, shown to the right of the profile identity block. Private by
// default: the owner always sees it (with a pin toggle to make it public);
// visitors see it only once pinned — mirroring the artwork pin. The earnings
// figure cycles ETH → USDC → USD (only currencies the artist has, plus the
// blended USD); paid-mint count underneath. Renders nothing when there's
// nothing to show, so it leaves no gap in the header row.
export function ProfileStats({ address, asVisitor }: { address: string; asVisitor: boolean }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [denom, setDenom] = useState<EarningsMetric>('usd')
  const [pinning, setPinning] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/stats?artist=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) {
          setStats({
            eth: d.eth ?? 0,
            usdc: d.usdc ?? 0,
            usd: d.usd ?? 0,
            mints: d.mints ?? 0,
            public: !!d.public,
          })
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

  // Offer only denominations the artist earned in, plus USD (the blend).
  const available = useMemo<EarningsMetric[]>(() => {
    if (!stats) return []
    const a: EarningsMetric[] = []
    if (stats.eth > 0) a.push('eth')
    if (stats.usdc > 0) a.push('usdc')
    if (stats.eth > 0 || stats.usdc > 0) a.push('usd')
    return a
  }, [stats])

  if (!stats) return null
  const hasEarnings = stats.mints > 0 && available.length > 0
  // Visitor (or owner previewing public view): only when pinned public.
  if (asVisitor && !(stats.public && hasEarnings)) return null
  // Owner: visible once there are earnings, even while private (so they can pin).
  if (!asVisitor && !hasEarnings) return null

  const active = available.includes(denom) ? denom : available[0]
  const multi = available.length > 1
  const cycle = () => {
    const next = available[(available.indexOf(active) + 1) % available.length]
    setDenom(next)
    try {
      localStorage.setItem(DENOM_STORAGE_KEY, next)
    } catch {}
  }

  const togglePublic = async () => {
    if (pinning) return
    const next = !stats.public
    setStats((s) => (s ? { ...s, public: next } : s)) // optimistic
    setPinning(true)
    try {
      const res = await fetch(`/api/profile/${address}/earnings-visibility`, {
        method: next ? 'POST' : 'DELETE',
      })
      if (!res.ok) setStats((s) => (s ? { ...s, public: !next } : s)) // revert
    } catch {
      setStats((s) => (s ? { ...s, public: !next } : s))
    } finally {
      setPinning(false)
    }
  }

  return (
    <div className="w-full sm:w-auto sm:ml-auto rounded-lg border border-line bg-raised px-4 py-3 font-mono">
      <div className="flex items-start justify-between gap-3">
        <div>
          <button
            onClick={multi ? cycle : undefined}
            className={`text-ink text-xl leading-tight ${
              multi ? 'cursor-pointer hover:text-accent transition-colors' : 'cursor-default'
            }`}
            title={multi ? 'Tap to switch currency' : undefined}
          >
            {formatEarningsValue(active, stats)}
          </button>
          <p className="text-muted text-xs mt-0.5">
            {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'}
          </p>
        </div>
        {!asVisitor && (
          <button
            onClick={togglePublic}
            disabled={pinning}
            aria-pressed={stats.public}
            title={stats.public ? 'Earnings public — tap to hide' : 'Make earnings public'}
            className="shrink-0 p-1 transition-colors disabled:opacity-50"
          >
            <Pin
              size={16}
              strokeWidth={1.5}
              className={stats.public ? 'text-accent fill-accent' : 'text-muted hover:text-dim'}
            />
          </button>
        )}
      </div>
      {!asVisitor && !stats.public && (
        <p className="text-faint text-[10px] mt-1.5">private · tap the pin to show</p>
      )}
    </div>
  )
}
