'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'
import { shortAddress } from '@/lib/inprocess'

interface Entrant {
  address: string
  enteredAt: number | null
  holdsNow: boolean
}

interface EntrantsResponse {
  entrants: Entrant[]
  winner: string | null
  state: 'open' | 'closed'
  count: number
}

/**
 * Admin-only raffle control for one (collection, tokenId). Renders nothing for
 * non-admins, so it can be dropped onto any moment (MomentDetailView, the
 * /patron showcase) and only admins see it.
 *
 * Two responsibilities:
 *  1. Enable / disable the raffle FOR THIS MOMENT (raffleEnabledKeys /
 *     toggleRaffleEnabled). This is what makes the "enter raffle" button appear
 *     for holders — enabling per moment is how a raffle is turned on now, until
 *     a mint-time toggle exists.
 *  2. Once enabled, list entrants (with their current on-chain holding) and let
 *     the admin MANUALLY pick the winner — no on-chain randomness. Picking
 *     closes entries; a winner can be cleared to re-pick (reopens entries).
 *
 * Disabling doesn't discard entrants — re-enabling restores them.
 *
 * The admin session (HttpOnly cookie via SIWE) is ensured by withSession, which
 * auto-attaches to the fetch — so these privileged routes authenticate the same
 * way the rest of the admin surface does.
 */
export function RaffleAdminPanel({
  collection,
  tokenId,
}: {
  collection: string
  tokenId: string
}) {
  const { isAdmin, withSession, raffleEnabledKeys, toggleRaffleEnabled } = useAdmin()
  const enabled = raffleEnabledKeys.has(`${collection.toLowerCase()}:${tokenId}`)
  const [data, setData] = useState<EntrantsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await withSession(async () => {
        const params = new URLSearchParams({ collection, tokenId })
        const r = await fetch(`/api/raffle/entrants?${params.toString()}`)
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(d.error ?? 'Failed to load entrants')
        }
        return (await r.json()) as EntrantsResponse
      })
      if (res) setData(res)
    } catch (err) {
      toastError('Raffle', err)
    } finally {
      setLoading(false)
    }
  }, [collection, tokenId, withSession])

  // Only load the entrant list once the raffle is actually enabled — a disabled
  // moment has no meaningful entrants to show.
  useEffect(() => {
    if (isAdmin && expanded && enabled && !data) void load()
  }, [isAdmin, expanded, enabled, data, load])

  if (!isAdmin) return null

  async function toggleEnabled() {
    if (
      enabled &&
      !window.confirm(
        'Disable the raffle for this moment? Holders stop seeing "enter raffle". Entrants are kept, so you can re-enable later.',
      )
    )
      return
    setToggling(true)
    try {
      await toggleRaffleEnabled(collection, tokenId)
    } finally {
      setToggling(false)
    }
  }

  async function pickWinner(address: string) {
    if (
      !window.confirm(
        `Set ${shortAddress(address)} as the raffle winner? This closes entries.`,
      )
    )
      return
    try {
      const ok = await withSession(async () => {
        const r = await fetch('/api/raffle/winner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection, tokenId, address }),
        })
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(d.error ?? 'Failed to set winner')
        }
        return true
      })
      if (ok) {
        toast.success('Winner recorded')
        await load()
      }
    } catch (err) {
      toastError('Raffle', err)
    }
  }

  async function resetWinner() {
    if (!window.confirm('Clear the winner and reopen entries?')) return
    try {
      const ok = await withSession(async () => {
        const params = new URLSearchParams({ collection, tokenId })
        const r = await fetch(`/api/raffle/winner?${params.toString()}`, {
          method: 'DELETE',
        })
        if (!r.ok) {
          const d = (await r.json().catch(() => ({}))) as { error?: string }
          throw new Error(d.error ?? 'Failed to clear winner')
        }
        return true
      })
      if (ok) {
        toast.success('Winner cleared — entries reopened')
        await load()
      }
    } catch (err) {
      toastError('Raffle', err)
    }
  }

  return (
    <div className="mt-4 border border-line">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-[10px] font-mono uppercase tracking-widest text-dim hover:text-ink transition-colors"
      >
        <span>Raffle admin</span>
        <span className="text-muted">{expanded ? '–' : '+'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-line pt-3">
          {/* Enable / disable the raffle for this moment — the switch that makes
              the "enter raffle" button appear for holders of this edition. */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-mono uppercase tracking-widest text-muted">
              {enabled ? 'raffle enabled' : 'raffle disabled'}
            </span>
            <button
              onClick={() => void toggleEnabled()}
              disabled={toggling}
              className={`text-[10px] font-mono uppercase tracking-widest transition-colors disabled:opacity-50 ${
                enabled ? 'text-muted hover:text-red-400' : 'text-accent hover:text-ink'
              }`}
            >
              {toggling ? '…' : enabled ? 'disable' : 'enable raffle'}
            </button>
          </div>

          {!enabled && (
            <p className="text-xs font-mono text-muted">
              Enable the raffle to start accepting entries from holders of this
              edition.
            </p>
          )}

          {enabled && (
            <>
              <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-muted">
                <span>
                  {data ? `${data.count} entrant${data.count === 1 ? '' : 's'}` : '…'}
                  {data ? ` · ${data.state}` : ''}
                </span>
                <button
                  onClick={() => void load()}
                  disabled={loading}
                  className="hover:text-ink transition-colors disabled:opacity-50"
                >
                  {loading ? 'loading…' : 'refresh'}
                </button>
              </div>

              {data?.winner && (
                <div className="flex items-center justify-between gap-2 border border-accent/50 bg-accent/10 px-3 py-2">
                  <span className="text-xs font-mono text-accent truncate">
                    winner: {shortAddress(data.winner)}
                  </span>
                  <button
                    onClick={resetWinner}
                    className="flex-shrink-0 text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink transition-colors"
                  >
                    clear
                  </button>
                </div>
              )}

              {data && data.entrants.length === 0 && (
                <p className="text-xs font-mono text-muted">no entrants yet</p>
              )}

              {data && data.entrants.length > 0 && (
                <ul className="flex flex-col divide-y divide-line border border-line">
                  {data.entrants.map((e) => {
                    const isWinner =
                      !!data.winner && data.winner.toLowerCase() === e.address.toLowerCase()
                    return (
                      <li
                        key={e.address}
                        className="flex items-center justify-between gap-3 px-3 py-2"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-mono text-dim truncate">
                            {shortAddress(e.address)}
                          </span>
                          {!e.holdsNow && (
                            <span
                              className="text-[9px] font-mono uppercase tracking-widest text-red-400/80"
                              title="No longer holds an edition"
                            >
                              sold
                            </span>
                          )}
                        </span>
                        {isWinner ? (
                          <span className="flex-shrink-0 text-[10px] font-mono uppercase tracking-widest text-accent">
                            winner
                          </span>
                        ) : (
                          <button
                            onClick={() => pickWinner(e.address)}
                            className="flex-shrink-0 text-[10px] font-mono uppercase tracking-widest text-muted hover:text-accent transition-colors"
                          >
                            select
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
