'use client'

/**
 * useCollectingAccount — Mode A UI hook for the Kismet collecting sub-account.
 *
 * Exposes the popup-less, budgeted in-session collect flow (see
 * lib/agent/scout/baseAccount.ts + inSessionCollect.ts, verified against
 * @base-org/account@2.4.0):
 *   - connect()              → provision/resolve the sub-account, load any budget
 *   - setBudgetAllowance()   → grant a USDC Spend Permission (one signature)
 *   - collect(items)         → collect a basket with no per-collect popup
 *   - revoke()               → revoke the budget on-chain
 *
 * Runtime behavior needs a live-wallet smoke test (no browser/RPC in CI); the
 * SDK API usage is type-verified.
 */

import { useCallback, useState } from 'react'
import { parseEther, parseUnits } from 'viem'
import {
  type CollectingAccounts,
  type CollectingBudget,
  type CollectingBudgetStatus,
  connectCollectingAccount,
  findCollectingBudget,
  getCollectingBudgetStatus,
  grantCollectingBudget,
  revokeCollectingBudget,
} from '@/lib/agent/scout/baseAccount'
import { collectInSession, type CollectItemRef, type InSessionCollectResult } from '@/lib/agent/scout/inSessionCollect'

type Phase = 'idle' | 'connecting' | 'granting' | 'collecting' | 'revoking'

export function useCollectingAccount() {
  const [accounts, setAccounts] = useState<CollectingAccounts | null>(null)
  const [budget, setBudget] = useState<CollectingBudget | null>(null)
  const [status, setStatus] = useState<CollectingBudgetStatus | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = useCallback(async (b: CollectingBudget | null) => {
    if (!b) {
      setStatus(null)
      return
    }
    try {
      setStatus(await getCollectingBudgetStatus(b))
    } catch {
      setStatus(null)
    }
  }, [])

  const connect = useCallback(async (): Promise<CollectingAccounts> => {
    setPhase('connecting')
    setError(null)
    try {
      const a = await connectCollectingAccount()
      setAccounts(a)
      const b = await findCollectingBudget(a.universal, a.subAccount)
      setBudget(b)
      await refreshStatus(b)
      return a
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect')
      throw e
    } finally {
      setPhase('idle')
    }
  }, [refreshStatus])

  const setBudgetAllowance = useCallback(
    async (allowance: string, periodInDays: number, currency: 'eth' | 'usdc' = 'usdc'): Promise<CollectingBudget> => {
      const a = accounts ?? (await connect())
      setPhase('granting')
      setError(null)
      try {
        const b = await grantCollectingBudget({
          universal: a.universal,
          subAccount: a.subAccount,
          currency,
          allowance: currency === 'eth' ? parseEther(allowance) : parseUnits(allowance, 6),
          periodInDays,
        })
        setBudget(b)
        await refreshStatus(b)
        return b
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not set budget')
        throw e
      } finally {
        setPhase('idle')
      }
    },
    [accounts, connect, refreshStatus],
  )

  const collect = useCallback(
    async (items: CollectItemRef[]): Promise<InSessionCollectResult> => {
      setPhase('collecting')
      setError(null)
      try {
        const result = await collectInSession(items)
        await refreshStatus(budget)
        return result
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not collect')
        throw e
      } finally {
        setPhase('idle')
      }
    },
    [budget, refreshStatus],
  )

  const revoke = useCallback(async (): Promise<void> => {
    if (!budget) return
    setPhase('revoking')
    setError(null)
    try {
      await revokeCollectingBudget(budget)
      setBudget(null)
      setStatus(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke')
      throw e
    } finally {
      setPhase('idle')
    }
  }, [budget])

  return { accounts, budget, status, phase, error, connect, setBudgetAllowance, collect, revoke }
}
