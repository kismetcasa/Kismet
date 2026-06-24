'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pin, Share2, Check, ChevronDown } from 'lucide-react'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { formatEarningsValue, rendersNonZero, type EarningsMetric } from '@/lib/earningsFormat'

interface Pending {
  eth: number
  usdc: number
  usd: number
  count: number
}

// Earnings in each denomination, for one source (mints or resales).
interface Breakdown {
  eth: number
  usdc: number
  usd: number
}

interface Stats {
  // Totals = primary (mints) + secondary (listing royalties).
  eth: number
  usdc: number
  usd: number
  mints: number
  public: boolean
  // Source split of the totals, so the card can show "mints vs resales".
  primary?: Breakdown
  secondary?: Breakdown
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
  initialEarnings: {
    eth: number
    usdc: number
    usd: number
    mints: number
    primary?: Breakdown
    secondary?: Breakdown
  } | null
}) {
  const { isInMiniApp } = useFarcaster()
  const [stats, setStats] = useState<Stats | null>(null)
  const [denom, setDenom] = useState<EarningsMetric>('usd')
  const [pinning, setPinning] = useState(false)
  const [copied, setCopied] = useState(false)
  // Mint-vs-resale breakdown disclosure. `splitPinned` is the click toggle (the
  // canonical action, works on touch); `splitHover` is a desktop mouse-only
  // preview. Either opens it.
  const [splitPinned, setSplitPinned] = useState(false)
  const [splitHover, setSplitHover] = useState(false)

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
            primary: d.primary,
            secondary: d.secondary,
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

  if (!stats) return null
  const hasEarnings = denoms.length > 0
  // The mint-vs-resale breakdown is only meaningful when the artist earned from
  // BOTH sources — then the mint-count line becomes a tap-to-expand toggle.
  const hasSecondary = !!stats.secondary && (stats.secondary.eth > 0 || stats.secondary.usdc > 0)
  const hasPrimaryValue = !!stats.primary && (stats.primary.eth > 0 || stats.primary.usdc > 0)
  const hasBothSources = hasSecondary && hasPrimaryValue
  const splitOpen = splitPinned || splitHover
  // The owner sees the card on ANY primary-sale activity — earnings OR mints — so
  // an artist whose attributed earnings resolve to 0 (e.g. value split entirely
  // to collaborators) still gets their mint count and the pin, instead of a card
  // that silently disappears. Visitors are unchanged: they only ever see a
  // pinned-public earnings figure.
  if (asVisitor) {
    if (!stats.public || !hasEarnings) return null
  } else if (!hasEarnings && stats.mints <= 0) {
    return null
  }

  const active: EarningsMetric | null = hasEarnings
    ? denoms.includes(denom)
      ? denom
      : denoms[0]
    : null
  const multi = denoms.length > 1

  // Owner-only: undistributed earnings sitting on their splits, labelled in the
  // first denomination that renders as non-zero at the card's display precision.
  // rendersNonZero is derived from formatEarningsValue's own precision, so the
  // show-gate can't drift from what's rendered — sub-display dust yields a null
  // denom and the line hides, so it never reads "$0".
  const pending = !asVisitor && stats.pending && stats.pending.count > 0 ? stats.pending : null
  const pendingDenom: EarningsMetric | null = !pending
    ? null
    : rendersNonZero('usd', pending)
      ? 'usd'
      : rendersNonZero('eth', pending)
        ? 'eth'
        : rendersNonZero('usdc', pending)
          ? 'usdc'
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
    if (!active) return
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
          {active ? (
            <button
              onClick={multi ? () => setDenom(denoms[(denoms.indexOf(active) + 1) % denoms.length]) : undefined}
              className={`text-ink text-xl leading-tight tabular-nums ${multi ? 'cursor-pointer hover:text-accent transition-colors' : 'cursor-default'}`}
              title={multi ? 'Tap to switch currency' : undefined}
            >
              {formatEarningsValue(active, stats)}
            </button>
          ) : (
            // No attributed earnings — surface the mint count as the headline so
            // the owner still sees their sales and the card doesn't disappear.
            stats.mints > 0 && (
              <p className="text-ink text-xl leading-tight tabular-nums">
                {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'}
              </p>
            )
          )}
          {active && stats.mints > 0 &&
            (hasBothSources ? (
              // Both sources → the mint count is a tap-to-expand toggle. Click
              // pins it (touch-safe); mouse hover previews it (desktop only, so a
              // tap on mobile can't get stuck open via a synthetic hover).
              <button
                type="button"
                onClick={() => setSplitPinned((v) => !v)}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'mouse') setSplitHover(true)
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === 'mouse') setSplitHover(false)
                }}
                aria-expanded={splitOpen}
                title="Mint sales vs resale royalties"
                className="flex items-center gap-1 text-muted text-xs mt-0.5 hover:text-dim transition-colors"
              >
                <span>
                  {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'}
                </span>
                <ChevronDown
                  size={11}
                  strokeWidth={2}
                  className={`transition-transform ${splitOpen ? 'rotate-180' : ''}`}
                />
              </button>
            ) : (
              <p className="text-muted text-xs mt-0.5">
                {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'mint' : 'mints'}
              </p>
            ))}
          {hasBothSources && splitOpen && active && stats.primary && stats.secondary && (
            <p className="text-faint text-xs mt-0.5 tabular-nums">
              {formatEarningsValue(active, stats.primary)} mints · {formatEarningsValue(active, stats.secondary)} resales
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
          {stats.public && hasEarnings && (
            <button onClick={share} title="Share" aria-label="Share earnings" className="p-1 text-muted hover:text-ink transition-colors">
              {copied ? <Check size={15} className="text-accent" /> : <Share2 size={15} strokeWidth={1.5} />}
            </button>
          )}
          {!asVisitor && hasEarnings && (
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
      {!asVisitor && !stats.public && hasEarnings && <p className="text-faint text-[10px] mt-1.5">private · tap the pin to show</p>}
    </div>
  )
}
