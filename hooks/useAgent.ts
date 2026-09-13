'use client'

/**
 * useAgent — powers Agent Collect, the autonomous budgeted agent (Phase 2, spend-permission model).
 *
 * Setup is one approval: grant a bounded Spend Permission to KISMET's server
 * spender (grantBudget). Thereafter the server (/api/agent/scout/run) collects
 * watched artists' new drops within the budget — no per-collect taps. Smart-wallet
 * only (an EOA can't grant the permission). v1 trigger: auto-run once on open +
 * a manual "Run now"; a server cron is the same run route later.
 *
 * Live behavior needs a Base Account smoke test (no wallet/RPC in CI).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseEther, parseUnits } from 'viem'
import { getAccount, getPublicClient } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { wagmiConfig } from '@/lib/wagmi'
import { useSmartWalletAgentEligibility } from '@/hooks/useSmartWalletAgentEligibility'
import { useUploadSession } from '@/hooks/useUploadSession'
import {
  grantScoutBudget,
  scoutBudgetStatus,
  revokeScoutBudget,
  SCOUT_SPENDER,
  type BudgetCurrency,
  type ScoutPermission,
} from '@/lib/agent/scout/grantBudget'
import type { BudgetUsage, Scout } from '@/lib/agent/scout/engine'
import type { ScoutLastRun } from '@/lib/agent/scout/store'

export interface WatchedArtist {
  address: string
  username?: string
}

export interface AgentConfigInput {
  name?: string
  artists: WatchedArtist[]
  currency: BudgetCurrency
  /** Budget per period, human decimal (e.g. "0.01" ETH or "20" USDC). */
  allowance: string
  periodInDays: number
  /** Max for a single collect, human decimal in the budget currency. */
  maxItemPrice: string
  maxItemsPerPeriod: number
  /** Editions to collect of each drop: 1 = Patron mode, N = Editions mode. */
  maxEditionsPerDrop: number
}

type BudgetStatus = Awaited<ReturnType<typeof scoutBudgetStatus>>
/** The latest run's outcome — persisted server-side (ScoutLastRun) and also
 *  what a "Run now" just returned. */
type RunResult = ScoutLastRun

interface AgentState {
  scout: Scout | null
  usage: BudgetUsage | null
  artistLabels: Record<string, string> | null
  permission: ScoutPermission | null
  away: boolean
}

const EMPTY: AgentState = { scout: null, usage: null, artistLabels: null, permission: null, away: false }

export function useAgent() {
  const { eligible, loading: eligLoading, reason: eligibilityReason } = useSmartWalletAgentEligibility()
  const { ensureSession } = useUploadSession()
  const [state, setState] = useState<AgentState>(EMPTY)
  const [status, setStatus] = useState<BudgetStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [lastRun, setLastRun] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoRanRef = useRef(false)
  /** Whether the autonomous spender is configured on this deployment. */
  const configured = !!SCOUT_SPENDER

  // Load the saved agent (owner-scoped via session) once eligible.
  useEffect(() => {
    if (eligLoading) return
    if (!eligible) {
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await fetch('/api/agent/scout')
        if (r.ok) {
          const d = (await r.json()) as AgentState & { lastRun?: RunResult | null }
          if (!cancelled) {
            setState({
              scout: d.scout ?? null,
              usage: d.usage ?? null,
              artistLabels: d.artistLabels ?? null,
              permission: d.permission ?? null,
              away: !!d.away,
            })
            if (d.lastRun) setLastRun(d.lastRun)
          }
        }
      } catch {
        /* keep empty; the panel shows setup */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [eligible, eligLoading])

  // Resolve the on-chain budget status whenever we hold a permission.
  useEffect(() => {
    if (!state.permission) {
      setStatus(null)
      return
    }
    let cancelled = false
    void scoutBudgetStatus(state.permission)
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [state.permission])

  /** Grant the budget (one approval) + persist the config. */
  const save = useCallback(
    async (cfg: AgentConfigInput): Promise<void> => {
      setError(null)
      try {
        // SIWE session FIRST so the config save can't 401 after the on-chain grant.
        await ensureSession()
        // The server refuses an account with no code (a plain EOA, or a Base
        // Account that has never transacted and is still counterfactual). Check
        // BEFORE the wallet signs a Spend Permission that would then never be
        // stored — and never revoked by Kismet. Fail-open on an RPC error, like
        // the server does.
        try {
          const acct = getAccount(wagmiConfig).address
          const code = acct ? await getPublicClient(wagmiConfig, { chainId: base.id })?.getCode({ address: acct }) : undefined
          if (acct && (!code || code === '0x')) {
            throw new Error(
              'Your Base Account needs one on-chain transaction before it can grant a spend permission — collect or send something first, then set up Agent Collect.',
            )
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('Your Base Account needs')) throw e
        }
        const allowance =
          cfg.currency === 'eth' ? parseEther(cfg.allowance) : parseUnits(cfg.allowance, 6)
        const permission = await grantScoutBudget({ currency: cfg.currency, allowance, periodInDays: cfg.periodInDays })

        // Build the engine budget snapshot from the REAL granted permission so the
        // engine + the chain share one window + allowance.
        const p = permission.permission
        const decimals = cfg.currency === 'eth' ? 18 : 6
        const creators = cfg.artists.map((a) => a.address.toLowerCase())
        const labels: Record<string, string> = {}
        for (const a of cfg.artists) if (a.username) labels[a.address.toLowerCase()] = a.username
        const draft: Partial<Scout> = {
          name: cfg.name,
          mode: 'auto',
          status: 'active',
          budget: { currency: cfg.currency, allowance: p.allowance, periodSeconds: p.period, start: p.start, end: p.end },
          policy: {
            collections: [],
            creators,
            blockedCollections: [],
            blockedCreators: [],
            maxItemPrice: parseUnits(cfg.maxItemPrice, decimals).toString(),
            maxItemsPerPeriod: cfg.maxItemsPerPeriod,
            maxEditionsPerDrop: cfg.maxEditionsPerDrop,
            mediaTypes: [],
          },
        }
        const r = await fetch('/api/agent/scout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scout: draft, permission, away: true, artistLabels: labels }),
        })
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? 'Could not save')
        const d = (await r.json()) as AgentState
        setState({ scout: d.scout, usage: d.usage, artistLabels: d.artistLabels ?? null, permission, away: true })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not set up the agent')
        throw e
      }
    },
    [ensureSession],
  )

  /** Trigger a server run now (the spender collects within the budget). */
  const runNow = useCallback(async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setError(null)
    try {
      const r = await fetch('/api/agent/scout/run', { method: 'POST' })
      const d = (await r.json().catch(() => ({}))) as Partial<RunResult> & { ran?: boolean; error?: string }
      if (r.ok && d.ran) {
        setLastRun({ at: Math.floor(Date.now() / 1000), collected: d.collected ?? 0, skipped: d.skipped ?? 0, reason: d.reason, skips: d.skips })
      } else if (!r.ok) setError(d.error ?? 'Run failed')
      if (state.permission) scoutBudgetStatus(state.permission).then(setStatus).catch(() => {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunning(false)
    }
  }, [running, state.permission])

  const setActive = useCallback(
    async (active: boolean): Promise<void> => {
      if (!state.scout) return
      const prev = state.scout
      const next: Scout = { ...prev, status: active ? 'active' : 'paused' }
      setState((s) => ({ ...s, scout: next }))
      setError(null)
      // A pause the server did not take is a stop the user believes in while
      // the agent keeps collecting — so a failure reverts the optimistic state
      // and says so, rather than waiting for the next load.
      try {
        const r = await fetch('/api/agent/scout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scout: next, away: state.away, artistLabels: state.artistLabels ?? {} }),
        })
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? 'save failed')
      } catch (e) {
        setState((s) => ({ ...s, scout: prev }))
        setError(`Could not ${active ? 'resume' : 'pause'} the agent — ${e instanceof Error ? e.message : 'try again'}`)
      }
    },
    [state.scout, state.away, state.artistLabels],
  )

  /** Turn off: delete the Kismet record; the server revokes the budget grant
   *  itself (revokeAsSpender — no wallet prompt) and says whether it landed.
   *  Only when it could not confirm do we ask the wallet for a user-signed
   *  revoke; if that is declined, Kismet keeps retrying in the background. */
  const remove = useCallback(async (): Promise<void> => {
    if (removing) return
    setRemoving(true)
    setError(null)
    try {
      // Session first (like save): an expired SIWE session must not turn into
      // a failed turn-off.
      await ensureSession()
      const r = await fetch('/api/agent/scout', { method: 'DELETE' })
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; revoked?: boolean; error?: string }
      if (!r.ok) throw new Error(d.error ?? 'Could not turn off the agent')
      let note: string | null = null
      if (d.revoked !== true && state.permission) {
        try {
          await revokeScoutBudget(state.permission)
        } catch {
          note =
            'Agent Collect is off. Its budget grant is still being revoked — Kismet keeps retrying, and you can revoke it from your Base Account any time.'
        }
      }
      setState(EMPTY)
      setStatus(null)
      setLastRun(null)
      if (note) setError(note)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not turn off the agent')
    } finally {
      setRemoving(false)
    }
  }, [removing, ensureSession, state.permission])

  // Auto-run once on open for an active, away-enabled agent (de-duped per mount).
  useEffect(() => {
    if (autoRanRef.current) return
    if (loading || running || !configured) return
    if (!state.scout || state.scout.status !== 'active' || !state.away || !state.permission) return
    autoRanRef.current = true
    void runNow()
  }, [loading, running, configured, state.scout, state.away, state.permission, runNow])

  return {
    eligible,
    eligibilityReason,
    configured,
    loading: eligLoading || loading,
    scout: state.scout,
    usage: state.usage,
    artistLabels: state.artistLabels,
    permission: state.permission,
    away: state.away,
    status,
    running,
    removing,
    lastRun,
    error,
    save,
    runNow,
    setActive,
    remove,
  }
}
