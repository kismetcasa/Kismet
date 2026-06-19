'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pin, Share2, Check } from 'lucide-react'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { formatEarningsValue, type EarningsMetric } from '@/lib/earningsFormat'

interface Pending {
  eth: number
  usdc: number
  usd: number
  count: number
}

interface Stats {
  eth: number
  usdc: number
  usd: number
  mints: number
  public: boolean
  // Undistributed earnings sitting on the artist's splits. Owner-only; absent
  // for visitors and for the public profile payload.
  pending?: Pending | null
}

// Earnings card to the right of the profile identity block. Private by default:
// the owner sees it with a pin to make it public; visitors only once pinned
// (mirroring the artwork pin). The figure taps to cycle ETH → USDC → USD.
export function ProfileStats({
  address,
  asVisitor,
  initialEarnings,
}: {
  address: string
  asVisitor: boolean
  initialEarnings: { eth: number; usdc: number; usd: number; mints: number } | null
}) {
  const { isInMiniApp } = useFarcaster()
  const [stats, setStats] = useState<Stats | null>(null)
  const [denom, setDenom] = useState<EarningsMetric>('usd')
  const [pinning, setPinning] = useState(false)
  const [copied, setCopied] = useState(false)

  // Public earnings arrive with the profile read (no extra request) — paint them
  // immediately. Visitors stop there. The owner always then fetches /api/stats:
  // for their own (possibly private) figures + pin, AND for their pending
  // (undistributed) roll-up, which is owner-only and never on the public payload
  // — so the owner fetches even when earnings are already public.
  useEffect(() => {
    if (initialEarnings) setStats({ ...initialEarnings, public: true })
    if (asVisitor) {
      if (!initialEarnings) setStats(null)
      return
    }
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
            pending: d.pending ?? null,
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address, asVisitor, initialEarnings])

  // Offer only denominations the artist earned in, plus the blended USD.
  const denoms = useMemo<EarningsMetric[]>(() => {
    if (!stats) return []
    const d: EarningsMetric[] = []
    if (stats.eth > 0) d.push('eth')
    if (stats.usdc > 0) d.push('usdc')
    // USD only when it's actually computable (price available) — never show $0.
    if (stats.usd > 0) d.push('usd')
    return d
  }, [stats])

  // Show whenever there are earnings (denoms non-empty) — including a split-only
  // collaborator with 0 mints. No earnings → nothing to show.
  if (!stats || denoms.length === 0) return null
  // Visitors (and the owner's public-view preview) see it only once pinned.
  if (asVisitor && !stats.public) return null

  const active = denoms.includes(denom) ? denom : denoms[0]
  const multi = denoms.length > 1

  // Owner-only: undistributed earnings sitting on their splits. Labelled in the
  // denomination that actually has a balance (USD when priceable, else the raw
  // token) so it never reads "0".
  const pending = !asVisitor && stats.pending && stats.pending.count > 0 ? stats.pending : null
  const pendingDenom: EarningsMetric | null = pending
    ? pending.usd > 0
      ? 'usd'
      : pending.eth > 0
        ? 'eth'
        : 'usdc'
    : null

  const togglePublic = async () => {
    if (pinning) return
    const next = !stats.public
    setStats((s) => (s ? { ...s, public: next } : s)) // optimistic
    setPinning(true)
    try {
      const res = await fetch(`/api/profile/${address}/earnings-visibility`, { method: next ? 'POST' : 'DELETE' })
      if (!res.ok) setStats((s) => (s ? { ...s, public: !next } : s)) // revert
    } catch {
      setStats((s) => (s ? { ...s, public: !next } : s))
    } finally {
      setPinning(false)
    }
  }

  // Differentiated share: Mini App → cast composer; share-capable browsers
  // (mobile + some desktop) → native sheet; otherwise → copy link.
  const share = async () => {
    const url = `${window.location.origin}/profile/${address}`
    const mintPart = stats.mints > 0 ? ` · ${stats.mints} ${stats.mints === 1 ? 'mint' : 'mints'}` : ''
    const text = `${formatEarningsValue(active, stats)} earned${mintPart} on Kismet`
    if (isInMiniApp) {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk')
        await sdk.actions.composeCast({ text, embeds: [url], channelKey: 'kismet' })
        return
      } catch {}
    }
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Kismet', text, url })
      } catch {}
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
            onClick={multi ? () => setDenom(denoms[(denoms.indexOf(active) + 1) % denoms.length]) : undefined}
            className={`text-ink text-xl leading-tight tabular-nums ${multi ? 'cursor-pointer hover:text-accent transition-colors' : 'cursor-default'}`}
            title={multi ? 'Tap to switch currency' : undefined}
          >
            {formatEarningsValue(active, stats)}
          </button>
          {stats.mints > 0 && (
            <p className="text-muted text-xs mt-0.5">
              {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'}
            </p>
          )}
          {pending && pendingDenom && (
            <p
              className="text-accent text-xs mt-0.5"
              title="Undistributed across your splits — open a moment to distribute"
            >
              {formatEarningsValue(pendingDenom, pending)} to distribute
            </p>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
          {stats.public && (
            <button onClick={share} title="Share" aria-label="Share earnings" className="p-1 text-muted hover:text-ink transition-colors">
              {copied ? <Check size={15} className="text-accent" /> : <Share2 size={15} strokeWidth={1.5} />}
            </button>
          )}
          {!asVisitor && (
            <button
              onClick={togglePublic}
              disabled={pinning}
              aria-pressed={stats.public}
              title={stats.public ? 'Earnings public — tap to hide' : 'Make earnings public'}
              aria-label="Toggle earnings visibility"
              className="p-1 transition-colors disabled:opacity-50"
            >
              <Pin size={15} strokeWidth={1.5} className={stats.public ? 'text-accent fill-accent' : 'text-muted hover:text-dim'} />
            </button>
          )}
        </div>
      </div>
      {!asVisitor && !stats.public && <p className="text-faint text-[10px] mt-1.5">private · tap the pin to show</p>}
    </div>
  )
}
