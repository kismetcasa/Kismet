'use client'

import { useCallback, useEffect, useState } from 'react'
import { useProfileNames } from '@/hooks/useProfileNames'
import Link from 'next/link'
import { toast } from 'sonner'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { formatOddsRatio, formatProbability } from '@/lib/experience/format'
import { isReveal } from '@/lib/experience/types'
import { DECLINE_NOTE_MAX, DECLINE_REASONS, declineText, type DeclineReason } from '@/lib/experience/decline'
import type { LineupPiece, Machine, PoolEntry, SolvencyProblemCode } from '@/lib/experience/types'

/**
 * The curator's review queue.
 *
 * Machines from non-admin creators land in `review` by design — open publishing
 * behind a moderation gate. Until this existed that was a one-way door: the
 * create route was the only caller of setMachineState, so nothing could ever
 * leave review. This is the other half.
 *
 * A reviewer is deciding whether to put something on sale that takes people's
 * money, so the row shows what that decision actually rests on: the full
 * lineup, the odds exactly as players would see them, and a re-run of the
 * solvency gate against live on-chain state. That re-run matters — headroom and
 * rival pledges both move while a machine waits, so approving on the verdict
 * recorded at submission could put an insolvent machine on sale.
 */

interface Row {
  machine: Machine
  pool: PoolEntry[]
  /** Capsule machines: the odds as players would see them. */
  odds?: { key: string; collection: string; tokenId: string; artist: string; probability: number; remaining: number | null }[]
  capsule?: { maxSupply: number | null; minted: number } | null
  /** Reveal machines: each piece's standing today. */
  lineup?: LineupPiece[]
  problems: { code: SolvencyProblemCode; detail: string }[]
}

const LINEUP_STATUS: Record<LineupPiece['status'], string> = {
  'on-sale': 'on sale',
  upcoming: 'sale opens later',
  'not-on-sale': 'not on sale',
  'sold-out': 'sold out',
  unavailable: 'unavailable',
  unreadable: 'unreadable',
}

const STATE_FILTERS = ['review', 'live', 'ended', 'delisted', 'draft'] as const

export function ExperienceReviewQueue() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [filter, setFilter] = useState<string>('review')
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The machine being turned down or delisted, and why: its creator is told.
  const [declining, setDeclining] = useState<string | null>(null)
  const [reason, setReason] = useState<DeclineReason | null>(null)
  const [note, setNote] = useState('')
  const nameOf = useProfileNames((rows ?? []).flatMap((r) => [r.machine.creator, ...r.pool.map((p) => p.artist), ...(r.odds ?? []).map((o) => o.artist)]))

  const load = useCallback(() => {
    fetch(`/api/admin/experience?state=${filter}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not load')
        return r.json()
      })
      .then((d: { machines: Row[] }) => { setRows(d.machines ?? []); setError(null) })
      .catch((e: Error) => { setError(e.message); setRows([]) })
  }, [filter])

  useEffect(() => { load() }, [load])

  const openDecline = (id: string | null) => {
    setDeclining(id)
    setReason(null)
    setNote('')
  }

  const setState = useCallback(
    async (id: string, state: string, why?: { reason: DeclineReason; note: string }) => {
      setBusy(id)
      try {
        const r = await fetch('/api/admin/experience', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, state, ...why }),
        })
        const body = await r.json().catch(() => null)
        if (!r.ok) {
          // A rejected promotion is the gate doing its job, so say which check
          // failed rather than a generic error.
          const detail = Array.isArray(body?.problems)
            ? body.problems.map((p: { detail: string }) => p.detail).join('; ')
            : (body?.error ?? 'Could not update')
          toast.error(detail)
          return
        }
        toast.success(body?.withdrawn ? `${id} turned down — withdrawn` : `${id} → ${state}`)
        setDeclining(null)
        load()
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  return (
    <div>
      <div className="flex flex-wrap gap-1 mb-4">
        {STATE_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border transition-colors ${
              filter === s ? 'border-ink text-ink' : 'border-line text-subtle hover:text-dim'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {error && <p className="text-xs font-mono text-[#ff7c80]">{error}</p>}
      {rows === null && <p className="text-xs font-mono text-muted">loading…</p>}
      {rows?.length === 0 && !error && (
        <p className="text-xs font-mono text-muted">nothing in {filter}</p>
      )}

      <div className="flex flex-col gap-3">
        {rows?.map((row) => {
          const m = row.machine
          const open = expanded === m.id
          const blocked = row.problems.length > 0
          // Never on sale: taking it off is turning it down, which withdraws it.
          const unlisted = !m.listedAt
          const why = declining === m.id && reason ? { reason, note: note.replace(/\s+/g, ' ').trim() } : null
          const whyReady = !!why && (why.reason !== 'other' || why.note.length > 0)
          return (
            <div key={m.id} className="border border-line">
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() => setExpanded(open ? null : m.id)}
                  className="flex-1 min-w-0 text-left"
                  aria-expanded={open}
                >
                  <p className="text-sm font-mono text-ink truncate">{m.name}</p>
                  <p className="text-[10px] font-mono text-subtle truncate">
                    {m.id} · by {nameOf(m.creator)} · {row.pool.length} artwork
                    {row.pool.length === 1 ? '' : 's'} ·{' '}
                    {isReveal(m)
                      ? 'reveal machine'
                      : row.capsule?.maxSupply === null
                        ? 'open capsule'
                        : `${row.capsule?.maxSupply ?? '?'} capsules`}
                  </p>
                </button>
                {blocked && (
                  <span className="text-[10px] font-mono uppercase tracking-wider text-[#ff7c80] shrink-0">
                    {row.problems.length} problem{row.problems.length === 1 ? '' : 's'}
                  </span>
                )}
                <span className="text-[10px] font-mono uppercase tracking-wider text-subtle shrink-0">
                  {m.state}
                </span>
              </div>

              {open && (
                <div className="border-t border-line px-4 py-3">
                  {blocked && (
                    <ul className="mb-4 flex flex-col gap-1">
                      {row.problems.map((p, i) => (
                        <li key={i} className="text-[11px] font-mono text-[#ff7c80]">
                          <span className="text-subtle uppercase tracking-wider">{p.code}</span> — {p.detail}
                        </li>
                      ))}
                    </ul>
                  )}

                  {isReveal(m) && m.collections?.length ? (
                    <p className="mb-2 text-[11px] font-mono text-muted">
                      auto-updating · new work minted into{' '}
                      {m.collections.map((c, i) => (
                        <span key={c}>
                          {i > 0 && ', '}
                          <Link href={`/collection/${c}`} className="text-dim hover:text-ink underline">{shortAddress(c)}</Link>
                        </span>
                      ))}{' '}
                      joins by itself
                    </p>
                  ) : null}
                  <div className="border border-line divide-y divide-line mb-4">
                    {row.lineup?.map((p) => (
                      <div key={p.key} className="flex items-center gap-3 px-3 py-2">
                        <Link
                          href={`/artwork/${p.collection}/${p.tokenId}`}
                          className="flex-1 min-w-0 text-[11px] font-mono text-dim hover:text-ink truncate"
                        >
                          #{p.tokenId} <span className="text-subtle">by {nameOf(p.artist)}</span>
                        </Link>
                        <span className="text-[10px] font-mono text-subtle shrink-0">{LINEUP_STATUS[p.status]}</span>
                        <span className="text-xs font-mono tabular-nums text-ink shrink-0 w-24 text-right">
                          {p.sale ? formatPrice(p.sale.pricePerToken, p.sale.currency) : ''}
                        </span>
                      </div>
                    ))}
                    {row.odds?.map((o) => (
                      <div key={o.key} className="flex items-center gap-3 px-3 py-2">
                        <Link
                          href={`/artwork/${o.collection}/${o.tokenId}`}
                          className="flex-1 min-w-0 text-[11px] font-mono text-dim hover:text-ink truncate"
                        >
                          #{o.tokenId} <span className="text-subtle">by {nameOf(o.artist)}</span>
                        </Link>
                        <span className="text-[10px] font-mono text-subtle shrink-0">
                          {o.remaining === null ? 'unlimited' : `${o.remaining} left`}
                        </span>
                        <span className="text-xs font-mono tabular-nums text-ink shrink-0 w-20 text-right">
                          {formatProbability(o.probability)}
                        </span>
                        <span className="text-[10px] font-mono tabular-nums text-subtle shrink-0 w-20 text-right">
                          {formatOddsRatio(o.probability) ?? ''}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setState(m.id, 'live')}
                      disabled={busy === m.id || blocked || m.state === 'live'}
                      title={blocked ? 'Fix the problems above before approving' : undefined}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider btn-accent disabled:opacity-40"
                    >
                      approve · live
                    </button>
                    {!unlisted && (
                      <button
                        onClick={() => setState(m.id, 'ended')}
                        disabled={busy === m.id || m.state === 'ended'}
                        className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40"
                      >
                        {isReveal(m) ? 'close' : 'end season'}
                      </button>
                    )}
                    <button
                      onClick={() => openDecline(declining === m.id ? null : m.id)}
                      disabled={busy === m.id || m.state === 'delisted'}
                      aria-expanded={declining === m.id}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-[#ff7c80] hover:bg-[#1a0d0d] disabled:opacity-40"
                    >
                      {unlisted ? 'turn down' : 'delist'}
                    </button>
                    {/* Only machines the public page shows: a queued or draft
                        machine 404s there, and its lineup is right above. */}
                    {m.state !== 'review' && m.state !== 'draft' && (
                      <Link
                        href={`/play/${m.id}`}
                        className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-subtle hover:text-dim"
                      >
                        view
                      </Link>
                    )}
                  </div>
                  {declining === m.id && (
                    <div className="mt-3 flex flex-col gap-2 border border-line p-3">
                      <p id={`why-${m.id}`} className="text-[10px] font-mono uppercase tracking-widest text-muted">
                        why — its creator is told
                      </p>
                      <div role="radiogroup" aria-labelledby={`why-${m.id}`} className="flex flex-wrap gap-1">
                        {(Object.keys(DECLINE_REASONS) as DeclineReason[]).map((k) => (
                          <button
                            key={k}
                            type="button"
                            role="radio"
                            aria-checked={reason === k}
                            onClick={() => setReason(k)}
                            className={`px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider border transition-colors ${
                              reason === k ? 'border-ink text-ink' : 'border-line text-subtle hover:text-dim'
                            }`}
                          >
                            {DECLINE_REASONS[k].label}
                          </button>
                        ))}
                      </div>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        maxLength={DECLINE_NOTE_MAX}
                        rows={2}
                        aria-label="note to the creator"
                        placeholder={reason === 'other' ? 'say why — required' : 'what, specifically (optional)'}
                        className="w-full bg-transparent border border-line px-3 py-2 text-xs font-mono text-ink placeholder:text-subtle focus:border-ink outline-none"
                      />
                      {why && whyReady && (
                        <p className="text-[11px] font-mono text-dim leading-relaxed">they will read: why: {declineText(why)}.</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => why && setState(m.id, 'delisted', why)}
                          disabled={busy === m.id || !whyReady}
                          className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-[#ff7c80] text-[#ff7c80] hover:bg-[#1a0d0d] disabled:opacity-40"
                        >
                          {unlisted ? 'turn down' : 'delist'} · tell them
                        </button>
                        <button
                          onClick={() => openDecline(null)}
                          className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-subtle hover:text-dim"
                        >
                          cancel
                        </button>
                      </div>
                    </div>
                  )}
                  <p className="text-[10px] font-mono text-subtle mt-2">
                    {unlisted ? (
                      <>
                        Turning a machine down withdraws it. It was never on sale, so nothing is owed through it: its
                        capsule, its hold on its pieces and its link are freed for the machine its creator fixes and
                        submits again.
                      </>
                    ) : (
                      <>
                        Ending a season and delisting both stop new listings only. Every capsule already sold stays
                        honourable, and the machine keeps its capsule token and its hold on its editions&apos; supply
                        for as long as those capsules are owed. To stop a particular piece being dispensed, hide it
                        or blacklist its artist.
                      </>
                    )}
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
