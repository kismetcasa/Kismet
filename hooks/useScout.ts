'use client'

/**
 * useScout — the budgeted, artist-watching auto-collect agent (Mode A).
 *
 * Wraps useCollectingAccount (the on-chain budget / sub-account) and adds the
 * Kismet-side policy + run loop. Smart-wallet only: gated by
 * useSmartWalletAgentEligibility, and the budget grant it needs can't be done by
 * an EOA — so EOAs never get a scout. Per-action collect/buy/list are untouched.
 *
 * Trigger model (chosen): auto-run once when an active 'auto' scout's owner
 * opens Kismet (single-flight, de-duped) PLUS a manual run().
 *
 * Live behavior needs a Base Account smoke test (no wallet/RPC in CI).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { parseUnits } from 'viem'
import { useSmartWalletAgentEligibility } from '@/hooks/useSmartWalletAgentEligibility'
import { useCollectingAccount } from '@/hooks/useCollectingAccount'
import { useUploadSession } from '@/hooks/useUploadSession'
import type { BudgetUsage, Scout } from '@/lib/agent/scout/engine'
import { runScout, type ScoutRunSummary } from '@/lib/agent/scout/runScout'

/** A watched artist, resolved from a username or pasted address. */
export interface WatchedArtist {
  address: string
  username?: string
}

export interface ScoutConfigInput {
  name?: string
  /** Watched artists (address + optional display username). */
  artists: WatchedArtist[]
  /** Budget currency: ETH (covers ETH drops + gas via MagicSpend) or USDC. */
  currency: 'eth' | 'usdc'
  /** Budget per period, human decimal (e.g. "0.01" ETH or "20" USDC). */
  allowance: string
  periodInDays: number
  /** Max for a single collect, human decimal in the budget currency. */
  maxItemPrice: string
  maxItemsPerPeriod: number
}

interface ScoutState {
  scout: Scout | null
  usage: BudgetUsage | null
  artistLabels: Record<string, string> | null
}

export function useScout() {
  const { eligible, loading: eligLoading } = useSmartWalletAgentEligibility()
  const ac = useCollectingAccount()
  const { ensureSession } = useUploadSession()
  const [{ scout, usage, artistLabels }, setState] = useState<ScoutState>({ scout: null, usage: null, artistLabels: null })
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [lastRun, setLastRun] = useState<ScoutRunSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const autoRanRef = useRef(false)

  // Load the saved scout (owner-scoped via session) once eligible.
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
          const d = (await r.json()) as ScoutState
          if (!cancelled) setState({ scout: d.scout ?? null, usage: d.usage ?? null, artistLabels: d.artistLabels ?? null })
        }
      } catch {
        /* keep null; the panel shows setup */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [eligible, eligLoading])

  // For an EXISTING scout, silently resolve the collecting account + budget on
  // load so the panel can show live status AND the auto-run gate (accounts +
  // status.isActive) can fire. connectCollectingAccount reads the already-
  // connected wagmi provider — no prompt in the normal case (the subAccounts
  // connector provisions accounts[1] at wallet-connect time).
  const acConnect = ac.connect
  const connectTriedRef = useRef(false)
  useEffect(() => {
    if (connectTriedRef.current) return
    if (loading || !scout || ac.accounts) return
    connectTriedRef.current = true
    void acConnect().catch(() => {})
  }, [loading, scout, ac.accounts, acConnect])

  /** Persist config (+ grant/extend the on-chain budget if the allowance/period
   *  changed). Builds the engine budget snapshot from the user's inputs. */
  const saveConfig = useCallback(
    async (cfg: ScoutConfigInput): Promise<void> => {
      setError(null)
      try {
        // 1. Establish the SIWE session FIRST so the config save can't 401 after
        //    we've granted the on-chain budget (which would orphan the budget).
        await ensureSession()
        // 2. Grant/extend the on-chain Spend Permission (idempotent — a retry
        //    reuses a matching active permission, no re-prompt/duplicate).
        const budget = await ac.setBudgetAllowance(cfg.allowance, cfg.periodInDays, cfg.currency)
        // 3. Build the engine budget snapshot from the REAL granted permission
        //    (its on-chain window + allowance), so the engine and the chain share
        //    one period window and the engine plans against the true allowance.
        const p = budget.permission
        const decimals = cfg.currency === 'eth' ? 18 : 6
        const creators = cfg.artists.map((a) => a.address.toLowerCase())
        const labels: Record<string, string> = {}
        for (const a of cfg.artists) if (a.username) labels[a.address.toLowerCase()] = a.username
        const draft: Partial<Scout> = {
          name: cfg.name,
          mode: 'auto',
          status: 'active',
          budget: {
            currency: cfg.currency,
            allowance: p.allowance,
            periodSeconds: p.period,
            start: p.start,
            end: p.end,
          },
          policy: {
            collections: [],
            creators,
            blockedCollections: [],
            blockedCreators: [],
            maxItemPrice: parseUnits(cfg.maxItemPrice, decimals).toString(),
            maxItemsPerPeriod: cfg.maxItemsPerPeriod,
            mediaTypes: [],
          },
        }
        const r = await fetch('/api/agent/scout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scout: draft, artistLabels: labels }),
        })
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? 'Could not save')
        const d = (await r.json()) as ScoutState
        setState({ scout: d.scout, usage: d.usage, artistLabels: d.artistLabels ?? null })
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save the agent')
        throw e
      }
    },
    [ac, ensureSession],
  )

  // Always re-send artistLabels on writes so a usage/status PUT doesn't wipe the
  // saved display names (the route stores exactly what it's given). When a run
  // collected something, pass `notify` so the server writes a "your agent
  // collected N" notification.
  const persistUsage = useCallback(
    async (
      s: Scout,
      u: BudgetUsage,
      labels: Record<string, string> | null,
      notify?: { collected: number; spent?: string; currency?: string },
    ) => {
      try {
        await fetch('/api/agent/scout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scout: s, usage: u, artistLabels: labels ?? {}, ...(notify ? { notify } : {}) }),
        })
      } catch {
        /* best-effort; on-chain cap is the real guard */
      }
    },
    [],
  )

  /** Run the scout now (or auto). Single-flight per tab; a cross-tab/device run
   *  lock prevents concurrent runs from double-collecting. No-op unless active +
   *  budget. */
  const run = useCallback(async (): Promise<void> => {
    if (!scout || !usage || running) return
    if (scout.status !== 'active') return
    if (!ac.accounts || !ac.status?.isActive) {
      setError('Your budget is inactive — top it up or set it again.')
      return
    }
    setRunning(true)
    setError(null)
    try {
      // Cross-tab/device run lock (best-effort; ~60s TTL). If another run holds
      // it, skip — prevents two opens from collecting the same drops.
      try {
        const lk = await fetch('/api/agent/scout', { method: 'POST' })
        if (lk.ok && ((await lk.json().catch(() => ({}))) as { acquired?: boolean }).acquired === false) return
      } catch {
        /* lock unavailable — the per-tab `running` guard still applies */
      }

      const { summary, usage: nextUsage } = await runScout(scout, usage, ac.budget, ac.accounts.universal)
      setState((prev) => ({ ...prev, usage: nextUsage }))
      setLastRun(summary)
      void persistUsage(scout, nextUsage, artistLabels, {
        collected: summary.collected,
        spent: summary.spent,
        currency: scout.budget.currency,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunning(false)
    }
  }, [scout, usage, running, ac.accounts, ac.status?.isActive, ac.budget, persistUsage, artistLabels])

  const setActive = useCallback(
    async (active: boolean): Promise<void> => {
      if (!scout) return
      const next: Scout = { ...scout, status: active ? 'active' : 'paused' }
      setState((s) => ({ ...s, scout: next }))
      try {
        await fetch('/api/agent/scout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scout: next, usage, artistLabels: artistLabels ?? {} }),
        })
      } catch {
        /* optimistic; revert on next load if it failed */
      }
    },
    [scout, usage, artistLabels],
  )

  // Auto-run once on open for an active 'auto' scout (after the budget status
  // has resolved so the isActive gate is meaningful). De-duped per mount.
  useEffect(() => {
    if (autoRanRef.current) return
    if (loading || running) return
    if (!scout || scout.status !== 'active' || scout.mode !== 'auto') return
    if (!ac.accounts || !ac.status?.isActive) return
    autoRanRef.current = true
    void run()
  }, [loading, running, scout, ac.accounts, ac.status?.isActive, run])

  return {
    eligible,
    loading: eligLoading || loading,
    scout,
    usage,
    artistLabels,
    ac,
    running,
    lastRun,
    error: error ?? ac.error,
    saveConfig,
    run,
    setActive,
  }
}
