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
  /** USDC budget per period (human decimal, e.g. "20"). */
  allowanceUsdc: string
  periodInDays: number
  /** Max USDC for a single collect (human decimal). */
  maxItemPriceUsdc: string
  maxItemsPerPeriod: number
}

interface ScoutState {
  scout: Scout | null
  usage: BudgetUsage | null
  artistLabels: Record<string, string> | null
}

const DAY = 86_400
const BUDGET_WINDOW_DAYS = 365 // permission validity window for the engine's soft active-check

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
        // 2. Grant/extend the on-chain Spend Permission for this allowance/period.
        await ac.setBudgetAllowance(cfg.allowanceUsdc, cfg.periodInDays)
        const now = Math.floor(Date.now() / 1000)
        const creators = cfg.artists.map((a) => a.address.toLowerCase())
        const labels: Record<string, string> = {}
        for (const a of cfg.artists) if (a.username) labels[a.address.toLowerCase()] = a.username
        const draft: Partial<Scout> = {
          name: cfg.name,
          mode: 'auto',
          status: 'active',
          budget: {
            currency: 'usdc',
            allowance: parseUnits(cfg.allowanceUsdc, 6).toString(),
            periodSeconds: Math.max(1, Math.floor(cfg.periodInDays * DAY)),
            start: now,
            end: now + BUDGET_WINDOW_DAYS * DAY,
          },
          policy: {
            collections: [],
            creators,
            blockedCollections: [],
            blockedCreators: [],
            maxItemPrice: parseUnits(cfg.maxItemPriceUsdc, 6).toString(),
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
  // saved display names (the route stores exactly what it's given).
  const persistUsage = useCallback(
    async (s: Scout, u: BudgetUsage, labels: Record<string, string> | null) => {
      try {
        await fetch('/api/agent/scout', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scout: s, usage: u, artistLabels: labels ?? {} }),
        })
      } catch {
        /* best-effort; on-chain cap is the real guard */
      }
    },
    [],
  )

  /** Run the scout now (or auto). Single-flight; no-op unless active + budget. */
  const run = useCallback(async (): Promise<void> => {
    if (!scout || !usage || running) return
    if (scout.status !== 'active') return
    if (!ac.status?.isActive) {
      setError('Your budget is inactive — top it up or set it again.')
      return
    }
    setRunning(true)
    setError(null)
    try {
      const { summary, usage: nextUsage } = await runScout(scout, usage, ac.budget)
      setState((prev) => ({ ...prev, usage: nextUsage }))
      setLastRun(summary)
      void persistUsage(scout, nextUsage, artistLabels)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run failed')
    } finally {
      setRunning(false)
    }
  }, [scout, usage, running, ac.status?.isActive, ac.budget, persistUsage, artistLabels])

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
