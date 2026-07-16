'use client'

/**
 * Agent Collect — the profile entry point.
 *
 * Replaces the always-open inline setup form with a compact status card: a
 * glanceable summary (active/paused, budget left, artists watched, next reset)
 * that opens the full setup/management panel in a modal — centered on desktop,
 * a bottom sheet on mobile and inside the Base app. This owns the single useAgent
 * instance and hands it to the panel, so the summary and the modal are always the
 * same state (a pause or save inside the modal reflects in the card instantly).
 *
 * Gating is unchanged: Base Account (smart-wallet) owners only, resolved by
 * useAgent → useSmartWalletAgentEligibility. Everyone else sees nothing.
 */

import { useState } from 'react'
import { formatUnits } from 'viem'
import { ChevronRight } from 'lucide-react'
import { useAgent } from '@/hooks/useAgent'
import { AgentCollectPanel } from './AgentCollectPanel'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'

export function AgentCollectEntry() {
  const ag = useAgent()
  const [open, setOpen] = useState(false)
  useBodyScrollLock(open)
  useEscapeKey(() => setOpen(false), open)

  // Same audience as the old panel — smart-wallet Base Accounts only.
  if (ag.loading || !ag.eligible) return null

  // Spender not wired on this deployment → the feature can't run. Show a subdued,
  // non-interactive note (no dead modal), mirroring the panel's own coming-soon state.
  if (!ag.configured) {
    return (
      <div className="border border-line bg-surface/40 px-4 py-3">
        <p className="text-[10px] font-mono uppercase tracking-wider text-dim mb-1">Agent Collect</p>
        <p className="text-xs font-mono text-dim leading-relaxed">
          Coming soon — autonomously collect new drops from artists you choose, within a budget you set.
        </p>
      </div>
    )
  }

  const scout = ag.scout
  const active = scout?.status === 'active'
  const dec = scout?.budget.currency === 'eth' ? 18 : 6
  const sym = scout?.budget.currency === 'eth' ? 'Ξ' : '$'
  const count = scout?.policy.creators.length ?? 0
  const plural = count === 1 ? '' : 's'

  // Status pill + one-line summary. Emphasis (text-ink) on the live status;
  // the not-yet-set-up pitch stays secondary (text-dim).
  let dotClass = 'bg-muted'
  let statusLabel = 'Set up'
  let summary = 'Auto-collect new drops from artists you choose.'
  let summaryClass = 'text-dim'
  if (scout && active) {
    const left = ag.status?.isActive
      ? `${sym}${formatUnits(ag.status.remainingSpend, dec)} left`
      : 'budget inactive'
    const resets = ag.status?.isActive ? ` · resets ${ag.status.nextPeriodStart.toLocaleDateString()}` : ''
    dotClass = 'bg-accent'
    statusLabel = 'Active'
    summary = `Watching ${count} artist${plural} · ${left}${resets}`
    summaryClass = 'text-ink'
  } else if (scout) {
    dotClass = 'bg-muted'
    statusLabel = 'Paused'
    summary = `Paused · ${count} artist${plural} watched`
    summaryClass = 'text-ink'
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="group w-full text-left border border-line bg-surface/40 px-4 py-3 hover:border-dim transition-colors"
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase tracking-wider text-dim">Agent Collect</span>
          <span className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-dim">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className={`text-xs font-mono leading-relaxed ${summaryClass}`}>{summary}</span>
          <ChevronRight size={14} className="shrink-0 text-muted group-hover:text-dim transition-colors" aria-hidden="true" />
        </div>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Agent Collect"
            className="w-full max-h-[88vh] overflow-y-auto border-t border-line bg-[#161616] pb-[env(safe-area-inset-bottom)] sm:max-w-md sm:max-h-[90vh] sm:border sm:pb-0"
          >
            <AgentCollectPanel ag={ag} onRequestClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}
