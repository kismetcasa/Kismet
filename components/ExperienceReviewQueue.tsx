'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { shortAddress } from '@/lib/inprocess'
import { formatOddsRatio, formatProbability } from '@/lib/experience/format'
import type { Machine, PoolEntry, SolvencyProblemCode } from '@/lib/experience/types'

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
  odds: { key: string; collection: string; tokenId: string; artist: string; probability: number; remaining: number | null }[]
  capsule: { maxSupply: number | null; minted: number } | null
  problems: { code: SolvencyProblemCode; detail: string }[]
}

const STATE_FILTERS = ['review', 'live', 'ended', 'delisted', 'draft'] as const

export function ExperienceReviewQueue() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [filter, setFilter] = useState<string>('review')
  const [busy, setBusy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const setState = useCallback(
    async (id: string, state: string) => {
      setBusy(id)
      try {
        const r = await fetch('/api/admin/experience', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, state }),
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
        toast.success(`${id} → ${state}`)
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
                    {m.id} · by {shortAddress(m.creator)} · {row.pool.length} artwork
                    {row.pool.length === 1 ? '' : 's'} ·{' '}
                    {row.capsule?.maxSupply === null ? 'open capsule' : `${row.capsule?.maxSupply ?? '?'} capsules`}
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

                  <div className="border border-line divide-y divide-line mb-4">
                    {row.odds.map((o) => (
                      <div key={o.key} className="flex items-center gap-3 px-3 py-2">
                        <Link
                          href={`/artwork/${o.collection}/${o.tokenId}`}
                          className="flex-1 min-w-0 text-[11px] font-mono text-dim hover:text-ink truncate"
                        >
                          #{o.tokenId} <span className="text-subtle">by {shortAddress(o.artist)}</span>
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
                    <button
                      onClick={() => setState(m.id, 'ended')}
                      disabled={busy === m.id || m.state === 'ended'}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink disabled:opacity-40"
                    >
                      end season
                    </button>
                    <button
                      onClick={() => setState(m.id, 'delisted')}
                      disabled={busy === m.id || m.state === 'delisted'}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-[#ff7c80] hover:bg-[#1a0d0d] disabled:opacity-40"
                    >
                      reject · delist
                    </button>
                    <Link
                      href={`/experience/${m.id}`}
                      className="px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-subtle hover:text-dim"
                    >
                      view
                    </Link>
                  </div>
                  <p className="text-[10px] font-mono text-subtle mt-2">
                    Ending a season stops sales and keeps every outstanding capsule honourable. Delisting also
                    releases this machine&apos;s hold on its editions&apos; supply.
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
