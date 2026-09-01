'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { shortAddress } from '@/lib/inprocess'

/**
 * A capsule machine, end to end: the lineup, the odds, the play, the reveal.
 *
 * ── The structural rule this component exists to enforce ──
 *
 * THE PLAY BUTTON AND THE ODDS TABLE ARE ONE COMPONENT, fed by one payload. If
 * the odds have not loaded, there is no button to press. That is deliberate and
 * it is not a nicety: Apple's Guideline 3.1.1 requires odds disclosure before a
 * randomized purchase, and Guideline 4.7 (extended to HTML5/JS mini apps in
 * November 2025) makes the native host responsible for embedded software — so
 * as a Farcaster Mini App, a play we allowed without disclosure is a rejection
 * risk for the HOST. Making the two inseparable in one render makes the
 * violation impossible rather than merely policed.
 */

interface OddsRow {
  key: string
  collection: string
  tokenId: string
  artist: string
  probability: number
  remaining: number | null
}

interface MachinePayload {
  machine: { id: string; name: string; state: string; creator: string; capsule: { collection: string; tokenId: string } }
  odds: OddsRow[]
  coverage: { capsulesOutstanding: number | null; prizesRemaining: number | null; covered: boolean }
  fairness: { epoch: string; commitment: string | null }
  recentPlays: { player: string; txHash: string }[]
}

type Phase = 'idle' | 'paying' | 'opening' | 'won' | 'pending'

interface Prize {
  collection: string
  tokenId: string
  artist: string
}

export function ExperienceMachine({ id }: { id: string }) {
  const ensureConnected = useEnsureConnected()
  const { collect } = useDirectCollect()

  const [data, setData] = useState<MachinePayload | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [prize, setPrize] = useState<Prize | null>(null)
  const [pendingReason, setPendingReason] = useState<string | null>(null)
  const [lastTx, setLastTx] = useState<string | null>(null)

  const load = useCallback(() => {
    fetch(`/api/experience/machines/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: MachinePayload) => setData(d))
      .catch(() => setLoadError(true))
  }, [id])

  useEffect(() => { load() }, [load])

  const play = useCallback(async () => {
    if (!data) return
    // Authoritative — reflects a wallet connected during this very tap, which
    // useAccount()'s render-scoped value would not yet show.
    const account = await ensureConnected()
    if (!account) return

    setPhase('paying')
    setPrize(null)
    setPendingReason(null)

    // Paying IS collecting the capsule — the same wallet path, the same toast
    // sequence, the same splits paying every pool artist at this instant.
    const res = await collect({
      collectionAddress: data.machine.capsule.collection as `0x${string}`,
      tokenId: data.machine.capsule.tokenId,
      amount: 1,
    })
    if (!res) { setPhase('idle'); return }
    setLastTx(res.hash)

    // The reveal is presentation only — the outcome is already being decided
    // server-side and is durable there. Closing this tab loses the animation,
    // never the artwork.
    setPhase('opening')
    try {
      const r = await fetch('/api/experience/play', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ machineId: id, txHash: res.hash, account, unitIndex: 0 }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok || !body?.ok) {
        setPhase('pending')
        setPendingReason('We could not open your capsule yet — it is safe and will be honoured.')
        return
      }
      if (body.claim?.state === 'delivered' && body.claim.prize) {
        setPrize(body.claim.prize)
        setPhase('won')
      } else {
        setPhase('pending')
        setPendingReason(body.claim?.pendingReason ?? 'Your artwork is on its way.')
      }
    } catch {
      setPhase('pending')
      setPendingReason('Your capsule is paid for and safe. Reload to see your artwork.')
    } finally {
      load()
    }
  }, [collect, data, ensureConnected, id, load])

  if (loadError) {
    return (
      <div className="border border-line p-8 sm:p-16 text-center">
        <p className="text-sm font-mono text-muted">this machine is unavailable</p>
      </div>
    )
  }

  // No odds, no button. See the header comment — this is the compliance
  // structure, not a loading nicety.
  if (!data) {
    return (
      <div className="border border-line p-8 sm:p-16 text-center">
        <p className="text-sm font-mono text-muted">loading the lineup…</p>
      </div>
    )
  }

  const playable = data.machine.state === 'live'
  const busy = phase === 'paying' || phase === 'opening'

  return (
    <div className="max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">{data.machine.name}</h1>
        <p className="text-[11px] font-mono text-muted mt-1">
          by {shortAddress(data.machine.creator)} · every play returns an artwork
        </p>
      </header>

      {/* The machine. The reveal replaces this face in place, so the capsule
          appears to open rather than the page appearing to navigate. */}
      <div className="border border-line bg-surface p-6 sm:p-10 text-center">
        {phase === 'won' && prize ? (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest accent-grad">you won</p>
            <Link
              href={`/artwork/${prize.collection}/${prize.tokenId}`}
              className="block mt-4 text-sm font-mono text-ink hover:underline"
            >
              view your artwork →
            </Link>
            <p className="text-[11px] font-mono text-muted mt-2">
              by {shortAddress(prize.artist)} · it is already in your wallet
            </p>
            <button
              onClick={play}
              disabled={busy || !playable}
              className="mt-6 px-5 py-2.5 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
            >
              play again
            </button>
          </div>
        ) : phase === 'pending' ? (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-ink">your artwork is on its way</p>
            <p className="text-[11px] font-mono text-muted mt-2 max-w-sm mx-auto">{pendingReason}</p>
            {lastTx && (
              <p className="text-[10px] font-mono text-subtle mt-3 break-all">{lastTx}</p>
            )}
          </div>
        ) : (
          <div>
            <p className="text-xs font-mono uppercase tracking-widest text-muted">
              {phase === 'opening' ? 'opening…' : phase === 'paying' ? 'confirm in wallet…' : 'insert coin'}
            </p>
            <button
              onClick={play}
              disabled={busy || !playable}
              className="mt-5 px-6 py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-40"
            >
              {playable ? 'play' : 'season closed'}
            </button>
          </div>
        )}
      </div>

      {/* Coverage — rendered from the same state the draw uses, so it cannot
          flatter the machine. */}
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-[11px] font-mono text-muted">
        <span>
          artworks left:{' '}
          <span className="text-dim">
            {data.coverage.prizesRemaining === null ? 'always available' : data.coverage.prizesRemaining}
          </span>
        </span>
        {data.coverage.capsulesOutstanding !== null && (
          <span>
            capsules left: <span className="text-dim">{data.coverage.capsulesOutstanding}</span>
          </span>
        )}
        {!data.coverage.covered && <span className="text-[#ff7c80]">coverage below capsules outstanding</span>}
      </div>

      {/* The odds. Derived server-side from the same snapshot a play draws from —
          there is no field anywhere a creator can type a percentage into. */}
      <section className="mt-8">
        <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-3">
          what&apos;s inside · published odds
        </h2>
        <div className="border border-line divide-y divide-line">
          {data.odds.map((o) => (
            <div key={o.key} className="flex items-center gap-3 px-3 py-2.5">
              <Link
                href={`/artwork/${o.collection}/${o.tokenId}`}
                className="flex-1 min-w-0 text-xs font-mono text-dim hover:text-ink truncate"
              >
                #{o.tokenId} <span className="text-subtle">by {shortAddress(o.artist)}</span>
              </Link>
              <span className="text-[11px] font-mono tabular-nums text-muted shrink-0">
                {o.remaining === null ? '∞' : `${o.remaining} left`}
              </span>
              <span
                className={`text-xs font-mono tabular-nums shrink-0 w-14 text-right ${
                  o.probability === 0 ? 'text-subtle' : 'text-ink'
                }`}
              >
                {(o.probability * 100).toFixed(1)}%
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Fairness. The commitment is published BEFORE any of today's plays
          exist, so a player can confirm the seed was fixed in advance. */}
      {data.fairness.commitment && (
        <section className="mt-6">
          <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">provably fair</h2>
          <p className="text-[11px] font-mono text-subtle leading-relaxed break-all">
            {data.fairness.epoch} commitment · {data.fairness.commitment}
          </p>
          <p className="text-[11px] font-mono text-muted mt-2">
            Today&apos;s seed and the exact odds table are locked in advance. After the day closes, any play can be
            recomputed at <span className="text-dim">/api/experience/verify</span>.
          </p>
        </section>
      )}

      {data.recentPlays.length > 0 && (
        <section className="mt-6">
          <h2 className="text-[11px] font-mono uppercase tracking-widest text-muted mb-2">recent plays</h2>
          <div className="flex flex-wrap gap-2">
            {data.recentPlays.map((p) => (
              <Link
                key={p.txHash}
                href={`/profile/${p.player}`}
                className="text-[10px] font-mono text-subtle hover:text-dim border border-line px-2 py-1"
              >
                {shortAddress(p.player)}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
