'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { toastError } from '@/lib/toast'
import { shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useRaffleManage } from '@/hooks/useRaffleManage'

interface RaffleStatus {
  enabled: boolean
  ended: boolean
  entriesOpen: boolean
  entriesCloseAt: number | null
  entrantCount: number
  winner: string | null
}

// unix seconds → value for <input type="datetime-local"> (local time, no tz).
function toLocalInput(unixSec: number | null): string {
  if (unixSec == null) return ''
  const d = new Date(unixSec * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}
const fmt = (unixSec: number | null) =>
  unixSec == null ? 'none' : new Date(unixSec * 1000).toLocaleString()

/**
 * Self-serve raffle controls for one (collection, tokenId), shown on the moment
 * detail page. Renders only when `canManage` (the moment's creator / a moment
 * admin / the platform admin — decided by the caller). Every mutation is a
 * signed, per-moment-authorized call (useRaffleManage → /api/raffle/manage).
 *
 * Lifecycle: enable (snapshots the sale end as the entries auto-close time) →
 * entries accrue until that time (or "close now") → "draw winner & end" picks a
 * winner from ELIGIBLE entrants (entered-then-sold are excluded) and releases
 * non-winners back to "list". Reopen un-ends; disable hides it (entrants kept).
 */
export function RaffleAdminPanel({
  collection,
  tokenId,
  canManage,
  defaultCloseAt = null,
}: {
  collection: string
  tokenId: string
  canManage: boolean
  /** Prefilled entries-close time on enable — the moment's sale end (unix s). */
  defaultCloseAt?: number | null
}) {
  const { busy, enable, disable, setCloseAt, drawAndEnd, reopen } = useRaffleManage(
    collection,
    tokenId,
  )
  const [status, setStatus] = useState<RaffleStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [closeInput, setCloseInput] = useState('')
  // Resolved display name for the drawn winner — the artist's next job is
  // contacting them, so the ended state links to their profile by name.
  const [winnerName, setWinnerName] = useState<string | null>(null)

  useEffect(() => {
    const w = status?.winner
    if (!w) {
      setWinnerName(null)
      return
    }
    let cancelled = false
    fetchCreatorProfile(w)
      .then(({ name }) => {
        if (!cancelled && name) setWinnerName(name)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [status?.winner])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ collection, tokenId })
      const r = await fetch(`/api/raffle/status?${params.toString()}`)
      if (!r.ok) throw new Error('Failed to load raffle status')
      const d = (await r.json()) as RaffleStatus
      setStatus(d)
      setCloseInput(toLocalInput(d.entriesCloseAt))
    } catch (err) {
      toastError('Raffle', err)
    } finally {
      setLoading(false)
    }
  }, [collection, tokenId])

  useEffect(() => {
    if (canManage && expanded && !status) void load()
  }, [canManage, expanded, status, load])

  if (!canManage) return null

  const after = async (p: Promise<unknown>) => {
    const ok = await p
    if (ok) await load()
    return ok
  }

  // The sale-end prefill rule, shared by the enable copy and the enable call:
  // the sale end only prefills the entries auto-close time while it's still
  // in the future. A function (not a captured value) so both evaluate fresh.
  const futureSaleEnd = () =>
    defaultCloseAt != null && defaultCloseAt > Math.floor(Date.now() / 1000)
      ? defaultCloseAt
      : null

  return (
    <div className="mt-4 border border-line">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-[10px] font-mono uppercase tracking-widest text-dim hover:text-ink transition-colors"
      >
        <span>Raffle</span>
        <span className="text-muted">{expanded ? '–' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-line pt-3">
          <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-muted">
            <span>
              {!status
                ? '…'
                : !status.enabled
                  ? 'not enabled'
                  : status.ended
                    ? 'ended'
                    : status.entriesOpen
                      ? `${status.entrantCount} entrant${status.entrantCount === 1 ? '' : 's'} · open`
                      : `${status.entrantCount} entrant${status.entrantCount === 1 ? '' : 's'} · entries closed`}
            </span>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="hover:text-ink transition-colors disabled:opacity-50"
            >
              {loading ? 'loading…' : 'refresh'}
            </button>
          </div>

          {/* Not enabled → offer to turn it on. The sale end prefills the
              auto-close time ONLY while it's still in the future — an elapsed
              sale end would create a raffle that is born closed (nothing to
              enter, "winner announced soon" forever); the server rejects that
              too, this just keeps the panel's happy path happy. futureSaleEnd
              is re-evaluated AT CLICK TIME (not captured at render) so a
              panel left open across the sale-end boundary can't send a
              just-elapsed timestamp the server would 400. */}
          {status && !status.enabled && (
            <>
              <p className="text-xs font-mono text-muted">
                Enable the raffle so holders of this edition can enter.
                {futureSaleEnd() != null
                  ? ` Entries will auto-close at the sale end (${fmt(futureSaleEnd())}).`
                  : defaultCloseAt != null
                    ? ' The sale has already ended — entries stay open until you close them.'
                    : ''}
              </p>
              <button
                onClick={() => void after(enable(futureSaleEnd()))}
                disabled={busy}
                className="self-start text-[10px] font-mono uppercase tracking-widest text-accent hover:text-ink transition-colors disabled:opacity-50"
              >
                {busy ? '…' : 'enable raffle'}
              </button>
            </>
          )}

          {/* Enabled, live → manage entries + draw. */}
          {status?.enabled && !status.ended && (
            <>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono uppercase tracking-widest text-muted">
                  entries auto-close
                </span>
                <span className="text-xs font-mono text-dim">{fmt(status.entriesCloseAt)}</span>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <input
                    type="datetime-local"
                    value={closeInput}
                    onChange={(e) => setCloseInput(e.target.value)}
                    className="bg-surface border border-line px-2 py-1 text-[11px] font-mono text-ink focus:outline-none focus:border-muted"
                  />
                  <button
                    onClick={() => void after(setCloseAt(fromLocalInput(closeInput)))}
                    disabled={busy}
                    className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors disabled:opacity-50"
                  >
                    set
                  </button>
                  <button
                    onClick={() => void after(setCloseAt(Math.floor(Date.now() / 1000)))}
                    disabled={busy}
                    className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors disabled:opacity-50"
                  >
                    close now
                  </button>
                  {status.entriesCloseAt != null && (
                    <button
                      onClick={() => void after(setCloseAt(null))}
                      disabled={busy}
                      className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors disabled:opacity-50"
                    >
                      clear
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        'Draw a winner from eligible entrants and end the raffle? Non-winners get the "list" action back. Entrants who sold their edition are excluded.',
                      )
                    )
                      void after(drawAndEnd())
                  }}
                  disabled={busy || status.entrantCount === 0}
                  className="text-[10px] font-mono uppercase tracking-widest text-accent hover:text-ink transition-colors disabled:opacity-50"
                >
                  {busy ? '…' : 'draw winner & end'}
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Disable this raffle? Entrants are kept; you can re-enable later.'))
                      void after(disable())
                  }}
                  disabled={busy}
                  className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-red-400 transition-colors disabled:opacity-50"
                >
                  disable
                </button>
              </div>
            </>
          )}

          {/* Ended → winner (linked to their profile — the artist's next job is
              reaching out to arrange the physical) + recovery controls. */}
          {status?.enabled && status.ended && (
            <>
              <div className="border border-accent/50 bg-accent/10 px-3 py-2 flex flex-col gap-1">
                {status.winner ? (
                  <>
                    <Link
                      href={`/profile/${status.winner}`}
                      className="inline-flex items-center gap-1 text-xs font-mono text-accent hover:underline w-fit"
                    >
                      winner: {winnerName ?? shortAddress(status.winner)}
                      <ArrowUpRight size={12} strokeWidth={1.5} />
                    </Link>
                    <span className="text-[10px] font-mono text-muted">
                      winner notification sent — open their profile to arrange delivery of the physical work
                    </span>
                  </>
                ) : (
                  <span className="text-xs font-mono text-accent">ended — no eligible winner</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => {
                    // Reopen can't retract anything already sent: the drawn
                    // winner was told "you won — you will be contacted", and
                    // that bell row + push stay delivered. Make the operator
                    // acknowledge that before clearing the result.
                    if (
                      window.confirm(
                        'Reopen this raffle? The drawn winner was already notified they won, and that notification cannot be retracted — drawing again may leave two people who were told they won. The result is cleared and entries reopen.',
                      )
                    )
                      void after(reopen())
                  }}
                  disabled={busy}
                  className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors disabled:opacity-50"
                >
                  reopen
                </button>
                <button
                  onClick={() => {
                    if (window.confirm('Disable this raffle? Entrants are kept; you can re-enable later.'))
                      void after(disable())
                  }}
                  disabled={busy}
                  className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-red-400 transition-colors disabled:opacity-50"
                >
                  disable
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
