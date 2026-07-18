'use client'

import { useEffect, useMemo, useState } from 'react'
import { Pin, Share2, Check, ChevronDown } from 'lucide-react'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useSignIn } from '@/hooks/useSignIn'
import { useAdmin } from '@/contexts/AdminContext'
import { formatEarningsValue, rendersNonZero, type EarningsMetric, type EarningsAmounts } from '@/lib/earningsFormat'
import { useDistributeAll } from '@/hooks/useDistributeAll'

interface Pending {
  eth: number
  usdc: number
  usd: number
  count: number
}

interface Stats {
  // Totals = primary (mints) + secondary (listing royalties).
  eth: number
  usdc: number
  usd: number
  mints: number
  public: boolean
  // Source split of the totals, so the card can show "sales vs resales".
  primary?: EarningsAmounts
  secondary?: EarningsAmounts
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
  adminView = false,
  initialEarnings,
}: {
  address: string
  asVisitor: boolean
  // Read-only privileged view: the platform admin looking at another artist's
  // card. Fetches and shows the figures (incl. private) like the owner does,
  // but never the pin — curation chrome stays owner-only. Distinct from
  // `asVisitor`, which stays true for the admin so no write affordances render.
  adminView?: boolean
  initialEarnings: {
    eth: number
    usdc: number
    usd: number
    mints: number
    primary?: EarningsAmounts
    secondary?: EarningsAmounts
  } | null
}) {
  const { isInMiniApp } = useFarcaster()
  const { ensureSession } = useUploadSession()
  // Admin SIWE session (kismetart-admin cookie), shared with curation — the
  // same session that unlocks /api/stats for the admin's read-only view.
  const { startSession } = useAdmin()
  const [stats, setStats] = useState<Stats | null>(null)
  const [denom, setDenom] = useState<EarningsMetric>('usd')
  const [pinning, setPinning] = useState(false)
  const [copied, setCopied] = useState(false)
  const [adminSigningIn, setAdminSigningIn] = useState(false)
  // Server withheld the figures on the owner path (see /api/stats
  // authRequired: no session, or a session for a different identity).
  // Renders a sign-in card in place of silence — without it a session-less
  // owner got a 200 shaped exactly like "no activity" and the card
  // unmounted, hiding real earnings AND the pin (the only opt-in surface)
  // with no feedback. `reloadTick` re-runs the fetch after sign-in; the
  // response handler — not the sign-in click — clears the flag, so a failed
  // refetch keeps the card up for a retry instead of unmounting it.
  const [authRequired, setAuthRequired] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  // Mint-vs-resale breakdown disclosure. `splitPinned` is the click toggle (the
  // canonical action, works on touch); `splitHover` is a desktop mouse-only
  // preview. Either opens it.
  const [splitPinned, setSplitPinned] = useState(false)
  const [splitHover, setSplitHover] = useState(false)
  // Currency-composition popover on the headline: shows the EXACT ETH + USDC
  // behind the blended USD. Desktop mouse-hover / keyboard-focus only — touch
  // users read each currency via the existing tap-to-cycle, so there's no
  // pin state to conflict with the headline's click-to-cycle.
  const [amountsHover, setAmountsHover] = useState(false)

  // Public earnings arrive with the profile read (no extra request) — paint them
  // immediately. Visitors stop there. The owner always then fetches /api/stats:
  // for their own (possibly private) figures + pin, AND for their pending
  // (undistributed) roll-up, which is owner-only and never on the public payload
  // — so the owner fetches even when earnings are already public.
  useEffect(() => {
    if (initialEarnings) setStats({ ...initialEarnings, public: true })
    // A plain visitor stops at the public figures. The owner AND the admin
    // (read-only) fetch /api/stats for the authoritative figures — the admin
    // to see private earnings for verification; the server releases them to
    // the admin cookie exactly as it does to the owner's session.
    if (asVisitor && !adminView) {
      if (!initialEarnings) setStats(null)
      return
    }
    let cancelled = false
    fetch(`/api/stats?artist=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return
        if (d.authRequired) {
          // No credentials reached the server — figures withheld. Show the
          // sign-in card instead of zeros (which would unmount the card).
          setAuthRequired(true)
          return
        }
        setAuthRequired(false)
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
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address, asVisitor, adminView, initialEarnings, reloadTick])

  // Collapse the breakdown when switching profiles, so it never carries an
  // expanded (or stuck mouse-hover) state over from another artist's card.
  useEffect(() => {
    setSplitPinned(false)
    setSplitHover(false)
    setAmountsHover(false)
    setAuthRequired(false)
  }, [address])

  // Offer only denominations that RENDER as non-zero at the card's display
  // precision (rendersNonZero), plus the blended USD. Gating on raw `> 0` let
  // sub-display dust through — an artist whose only earnings round to zero saw
  // a headline of "$0" / "0 ETH", which reads as a broken total. USD also
  // hides when the price is unavailable (the server sends usd=0 then).
  const denoms = useMemo<EarningsMetric[]>(() => {
    if (!stats) return []
    const d: EarningsMetric[] = []
    if (rendersNonZero('eth', stats)) d.push('eth')
    if (rendersNonZero('usdc', stats)) d.push('usdc')
    if (rendersNonZero('usd', stats)) d.push('usd')
    return d
  }, [stats])

  // Point-of-need sign-in (one SIWE signature → 7-day session). Shared flow
  // with SignInPrompt via useSignIn; only the owner context ever sets
  // authRequired, so visitors never see this.
  const { signIn, signingIn } = useSignIn(() => setReloadTick((t) => t + 1))

  // Owner-only "distribute all": one signature settles the top splits by value;
  // on completion, refetch so the pending line reflects the drained balances.
  const { distributeAll, distributing } = useDistributeAll(() => setReloadTick((t) => t + 1))

  // Admin sign-in for the read-only view: establishes the admin session, then
  // refetches. The response handler (not this click) clears authRequired, so a
  // cancelled/failed signature keeps the card up for a retry.
  const signInAdmin = async () => {
    if (adminSigningIn) return
    setAdminSigningIn(true)
    try {
      await startSession()
    } finally {
      setAdminSigningIn(false)
      setReloadTick((t) => t + 1)
    }
  }

  if ((!asVisitor || adminView) && authRequired) {
    // Same card, two flows: the admin authenticates its own SIWE session
    // (shared with curation), the owner authenticates the user session.
    const onSignIn = adminView ? signInAdmin : signIn
    const busy = adminView ? adminSigningIn : signingIn
    return (
      <div className="w-full sm:w-auto sm:ml-auto rounded-xl border border-line bg-raised px-4 py-3 font-mono">
        <p className="text-muted text-xs">
          {adminView ? 'sign in as admin to view earnings' : 'sign in to view your earnings'}
        </p>
        <button
          onClick={onSignIn}
          disabled={busy}
          className="text-accent text-xs mt-1 hover:underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'signing in…' : 'sign in'}
        </button>
      </div>
    )
  }

  if (!stats) return null
  const hasEarnings = denoms.length > 0
  // The mint-vs-resale breakdown is only meaningful when the artist earned from
  // BOTH sources — then the mint-count line becomes a tap-to-expand toggle.
  const hasSecondary = !!stats.secondary && (stats.secondary.eth > 0 || stats.secondary.usdc > 0)
  const hasPrimaryValue = !!stats.primary && (stats.primary.eth > 0 || stats.primary.usdc > 0)
  const hasBothSources = hasSecondary && hasPrimaryValue
  const splitOpen = splitPinned || splitHover
  // The mint-count line anchors a tap-to-expand toggle. A split collaborator can
  // have primary earnings but 0 personal mints (no count line) — there's nothing
  // to anchor a toggle to, so their breakdown shows statically (no toggle). Toggle
  // only when there IS a count line to declutter.
  const showSplitToggle = hasBothSources && stats.mints > 0
  // The owner sees the card on ANY primary-sale activity — earnings OR mints — so
  // an artist whose attributed earnings resolve to 0 (e.g. value split entirely
  // to collaborators) still gets their mint count and the pin, instead of a card
  // that silently disappears. Visitors are unchanged: they only ever see a
  // pinned-public earnings figure.
  if (asVisitor && !adminView) {
    if (!stats.public || !hasEarnings) return null
  } else if (!hasEarnings && stats.mints <= 0 && !stats.public) {
    // Signed-in owner with genuinely nothing yet: render an explicit
    // $0 / 0 sales card rather than unmounting, so a new artist sees the
    // earnings surface exists and knows they simply haven't earned. Honest —
    // these are REAL zeros from an authenticated read; contrast the
    // signed-out case (authRequired above), where the amount is unknown and a
    // fabricated $0 would mislead. No pin/share: there's nothing to make
    // public or share at zero — both appear once real earnings land and the
    // full card below takes over. (A pinned dust-artist has stats.public, so
    // this branch is skipped and they fall through to the full card, keeping
    // the pin — their only unpin surface — reachable.)
    return (
      <div className="w-full sm:w-auto sm:ml-auto rounded-xl border border-line bg-raised px-4 py-3 font-mono">
        <p className="text-ink text-xl leading-tight tabular-nums">{formatEarningsValue('usd', stats)}</p>
        <p className="text-muted text-xs mt-0.5">{stats.mints.toLocaleString('en-US')} sales</p>
      </div>
    )
  }

  const active: EarningsMetric | null = hasEarnings
    ? denoms.includes(denom)
      ? denom
      : denoms[0]
    : null
  const multi = denoms.length > 1
  // Exact crypto composition behind the blended USD headline — the popover
  // lists each non-zero denomination (ETH / USDC) at full display precision, so
  // an artist can see what their $ figure is actually made of. Shown only when
  // there IS crypto to break out (skip a pure-nothing card).
  const cryptoDenoms = denoms.filter((d): d is 'eth' | 'usdc' => d !== 'usd')
  const showAmounts = !!active && cryptoDenoms.length > 0

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
      // Same prompt-first idiom as every session-cookie write (MomentDetailView,
      // CollectionView, MintForm): a cached-valid session is a no-op, a missing
      // one costs one SIWE signature and the toggle completes in the same
      // gesture. A rejected wallet prompt throws → the catch reverts the pin.
      await ensureSession()
      const res = await fetch(`/api/profile/${address}/earnings-visibility`, { method: next ? 'POST' : 'DELETE' })
      if (!res.ok) {
        setStats((s) => (s ? { ...s, public: !next } : s)) // revert
        // Session the cache believed in was actually dead (or belongs to a
        // different identity): surface the sign-in card rather than a pin
        // that silently snaps back — its click revalidates the cache.
        if (res.status === 401 || res.status === 403) setAuthRequired(true)
      }
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
    const salePart = stats.mints > 0 ? ` · ${stats.mints} ${stats.mints === 1 ? 'sale' : 'sales'}` : ''
    const text = `${formatEarningsValue(active, stats)} earned${salePart} on Kismet`
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
            <span
              className="relative inline-block"
              // Desktop mouse / keyboard only — touch reads each currency via
              // the tap-to-cycle below, so no pin state is needed.
              onPointerEnter={(e) => { if (e.pointerType === 'mouse' && showAmounts) setAmountsHover(true) }}
              onPointerLeave={(e) => { if (e.pointerType === 'mouse') setAmountsHover(false) }}
            >
              <button
                onClick={multi ? () => setDenom(denoms[(denoms.indexOf(active) + 1) % denoms.length]) : undefined}
                onFocus={() => { if (showAmounts) setAmountsHover(true) }}
                onBlur={() => setAmountsHover(false)}
                aria-describedby={amountsHover && showAmounts ? 'earnings-amounts' : undefined}
                className={`text-ink text-xl leading-tight tabular-nums ${multi ? 'cursor-pointer hover:text-accent transition-colors' : 'cursor-default'}`}
                title={[
                  // The blended USD is lifetime crypto at TODAY'S price, not the
                  // sum of what each sale was worth on its day — say so, or an
                  // artist reconciling against their wallet history reads the
                  // moving figure as a wrong total.
                  active === 'usd' ? 'USD value at the current ETH price' : null,
                  multi ? 'Tap to switch currency' : null,
                ].filter(Boolean).join(' — ') || undefined}
              >
                {formatEarningsValue(active, stats)}
              </button>
              {/* Currency-composition popover: the exact ETH + USDC behind the
                  blended USD, at full display precision. Reuses formatEarningsValue
                  so it can never drift from the headline. */}
              {amountsHover && showAmounts && (
                <div
                  id="earnings-amounts"
                  role="tooltip"
                  className="absolute left-0 top-full z-20 mt-1 w-max min-w-[8rem] rounded-lg border border-line bg-surface px-3 py-2 shadow-lg"
                >
                  <p className="text-faint text-[10px] uppercase tracking-wide mb-1">accumulated</p>
                  <div className="flex flex-col gap-0.5 tabular-nums">
                    {cryptoDenoms.map((d) => (
                      <p key={d} className="text-ink text-xs">{formatEarningsValue(d, stats)}</p>
                    ))}
                    {rendersNonZero('usd', stats) && (
                      <p className="text-muted text-[11px] mt-0.5 pt-1 border-t border-raised">
                        ≈ {formatEarningsValue('usd', stats)}
                        <span className="text-faint"> at today’s ETH price</span>
                      </p>
                    )}
                  </div>
                </div>
              )}
            </span>
          ) : (
            // No attributed earnings — surface the sale count as the headline so
            // the owner still sees their sales and the card doesn't disappear.
            stats.mints > 0 && (
              <p className="text-ink text-xl leading-tight tabular-nums">
                {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'sale' : 'sales'}
              </p>
            )
          )}
          {active && stats.mints > 0 &&
            (showSplitToggle ? (
              // Sale count doubles as a tap-to-expand toggle. Click pins it
              // (touch-safe); mouse hover previews it (desktop only, gated to a
              // mouse pointer so a tap on mobile can't get stuck open via a
              // synthetic hover).
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
                aria-controls="earnings-source-split"
                title="Mint sales vs resale royalties (resales sold through Kismet listings)"
                className="flex items-center gap-1 text-muted text-xs mt-0.5 hover:text-dim transition-colors"
              >
                <span>
                  {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'sale' : 'sales'}
                </span>
                <ChevronDown
                  size={11}
                  strokeWidth={2}
                  className={`transition-transform ${splitOpen ? 'rotate-180' : ''}`}
                />
              </button>
            ) : (
              <p className="text-muted text-xs mt-0.5">
                {stats.mints.toLocaleString('en-US')} {stats.mints === 1 ? 'sale' : 'sales'}
              </p>
            ))}
          {/* Always mounted when both sources exist so the toggle's aria-controls
              resolves; `hidden` (display:none) collapses it for the toggle case and
              the 0-mint collaborator (no toggle) just shows it. */}
          {active && hasBothSources && stats.primary && stats.secondary && (
            <p
              id="earnings-source-split"
              hidden={showSplitToggle && !splitOpen}
              className="text-faint text-xs mt-0.5 tabular-nums"
              title="Resales counted are those sold through Kismet listings"
            >
              {formatEarningsValue(active, stats.primary)} sales · {formatEarningsValue(active, stats.secondary)} resales
            </p>
          )}
          {pending && pendingDenom && (
            <button
              type="button"
              onClick={distributeAll}
              disabled={distributing}
              title="Settle your undistributed split earnings — one signature distributes your highest-value artworks; also pays your collaborators on them. Tap again for more."
              className="flex items-center gap-1 text-accent text-xs mt-0.5 hover:underline transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {distributing
                ? 'distributing…'
                : `${formatEarningsValue(pendingDenom, pending)} to distribute →`}
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1 -mt-0.5">
          {stats.public && hasEarnings && (
            <button onClick={share} title="Share" aria-label="Share earnings" className="p-1 text-muted hover:text-ink transition-colors">
              {copied ? <Check size={15} className="text-accent" /> : <Share2 size={15} strokeWidth={1.5} />}
            </button>
          )}
          {/* Pin renders on hasEarnings OR an existing public pin: an owner
              whose earnings round to zero at display precision (dust) must
              still be able to UNPIN — this button is the only unpin surface,
              and without the stats.public escape hatch a dust artist would be
              stuck publicly pinned forever. */}
          {!asVisitor && (hasEarnings || stats.public) && (
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
      {/* Read-only visibility state for the admin — confirms at a glance
          whether the artist has published earnings (what a visitor would see)
          vs. kept them private, without exposing the owner's pin control. */}
      {adminView && hasEarnings && (
        <p className="text-faint text-[10px] mt-1.5">
          {stats.public ? 'public · visible to visitors' : 'private · hidden from visitors'}
        </p>
      )}
    </div>
  )
}
