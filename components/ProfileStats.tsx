'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pin, Share2, Check } from 'lucide-react'
import { useFarcaster } from '@/providers/FarcasterProvider'
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
// visitors see it only once pinned — mirroring the artwork pin. The figure taps
// to cycle ETH → USDC → USD (only currencies the artist has, plus the blended
// USD); paid-mint count underneath. Once public, a share button appears that
// adapts to the environment (Farcaster cast / native share sheet / copy link).
export function ProfileStats({ address, asVisitor }: { address: string; asVisitor: boolean }) {
  const { isInMiniApp } = useFarcaster()
  const [stats, setStats] = useState<Stats | null>(null)
  const [denom, setDenom] = useState<EarningsMetric>('usd')
  const [pinning, setPinning] = useState(false)
  const [copied, setCopied] = useState(false)

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

  // Differentiated share: Farcaster Mini App → cast composer; share-capable
  // browsers (mobile + some desktop) → native share sheet; everything else
  // (most desktop) → copy link. The shared profile URL unfurls to the OG card,
  // which only renders earnings when public — matching this button's gate.
  const share = async () => {
    const url = `${window.location.origin}/profile/${address}`
    const text = `${formatEarningsValue(active, stats)} earned · ${stats.mints} ${
      stats.mints === 1 ? 'mint' : 'mints'
    } on Kismet`

    if (isInMiniApp) {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk')
        await sdk.actions.composeCast({ text, embeds: [url], channelKey: 'kismet' })
        return
      } catch {
        // host composer unavailable — fall through to web share / copy
      }
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Kismet', text, url })
      } catch {
        // user dismissed the sheet (or it failed) — no-op, don't also copy
      }
      return
    }
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <div className="w-full sm:w-auto sm:ml-auto rounded-xl border border-line bg-raised px-4 py-3 font-mono">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <button
            onClick={multi ? cycle : undefined}
            className={`text-ink text-xl leading-tight tabular-nums ${
              multi ? 'cursor-pointer hover:text-accent transition-colors' : 'cursor-default'
            }`}
            title={multi ? 'Tap to switch currency' : undefined}
          >
            {formatEarningsValue(active, stats)}
          </button>
          <p className="text-muted text-xs mt-0.5">
            {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'} earned
          </p>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
          {stats.public && (
            <button
              onClick={share}
              title="Share"
              aria-label="Share earnings"
              className="p-1 text-muted hover:text-ink transition-colors"
            >
              {copied ? (
                <Check size={15} className="text-accent" />
              ) : (
                <Share2 size={15} strokeWidth={1.5} />
              )}
            </button>
          )}
          {!asVisitor && (
            <button
              onClick={togglePublic}
              disabled={pinning}
              aria-pressed={stats.public}
              title={stats.public ? 'Earnings public — tap to hide' : 'Make earnings public'}
              aria-label={stats.public ? 'Hide earnings' : 'Make earnings public'}
              className="p-1 transition-colors disabled:opacity-50"
            >
              <Pin
                size={15}
                strokeWidth={1.5}
                className={stats.public ? 'text-accent fill-accent' : 'text-muted hover:text-dim'}
              />
            </button>
          )}
        </div>
      </div>
      {!asVisitor && !stats.public && (
        <p className="text-faint text-[10px] mt-1.5">private · tap the pin to show</p>
      )}
    </div>
  )
}
