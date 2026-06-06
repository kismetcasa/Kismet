'use client'

/**
 * Auto-collect — setup + management panel (owner profile, smart-wallet only).
 *
 * The user-facing surface for the agent's budgeted, tap-free collecting. Gated by
 * useSmartWalletAgentEligibility (sub-accounts/spend-permissions need a smart
 * wallet — EOAs can't), and built on the stable useCollectingAccount interface.
 *
 * NOTE: goes live once the wagmi `baseAccount` connector is configured with
 * `subAccounts` and the wrapper uses the connected provider — see
 * AGENT_SUBACCOUNT_INTEGRATION.md (smoke-test-gated). Mount in ProfileView's
 * owner section once that wiring lands; until then it's intentionally unmounted.
 */

import { useState } from 'react'
import { formatUnits } from 'viem'
import { useSmartWalletAgentEligibility } from '@/hooks/useSmartWalletAgentEligibility'
import { useCollectingAccount } from '@/hooks/useCollectingAccount'

const PERIODS = [
  { label: 'per day', days: 1 },
  { label: 'per week', days: 7 },
  { label: 'per month', days: 30 },
] as const

export function AutoCollectPanel() {
  const { eligible, loading } = useSmartWalletAgentEligibility()
  const ac = useCollectingAccount()
  const [showForm, setShowForm] = useState(false)
  const [amount, setAmount] = useState('')
  const [periodDays, setPeriodDays] = useState<number>(7)

  const busy = ac.phase !== 'idle'

  // Don't flash anything until eligibility resolves.
  if (loading) return null

  if (!eligible) {
    return (
      <div className="border border-line p-4">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink mb-1">Auto-collect</h3>
        <p className="text-xs font-mono text-dim leading-relaxed">
          Tap-free, budgeted collecting — available with a Base Account (smart wallet).
          Open Kismet in the Base App to enable it.
        </p>
      </div>
    )
  }

  const status = ac.status
  const active = !!status?.isActive

  function toggle() {
    const next = !showForm
    setShowForm(next)
    // Load the account + any existing budget on first open (the user is already
    // connected via wagmi, so this resolves without a fresh prompt).
    if (next && !ac.accounts) void ac.connect()
  }

  async function grant() {
    const v = parseFloat(amount)
    if (!amount || Number.isNaN(v) || v <= 0) return
    try {
      await ac.setBudgetAllowance(amount, periodDays)
      setShowForm(false)
    } catch {
      // surfaced via ac.error
    }
  }

  return (
    <div className="border border-line p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink">Auto-collect</h3>
        <button
          onClick={toggle}
          disabled={busy}
          className="text-[10px] font-mono uppercase tracking-wider text-dim hover:text-accent transition-colors disabled:opacity-50"
        >
          {showForm ? 'close' : active ? 'manage' : 'set up'}
        </button>
      </div>

      {!showForm && (
        <p className="text-xs font-mono text-dim leading-relaxed mt-1">
          {active && status
            ? `Collecting tap-free · $${formatUnits(status.remainingSpend, 6)} left · resets ${status.nextPeriodStart.toLocaleDateString()}`
            : 'Approve once, then collect tap-free up to a budget you set. Your Base Account pays and receives; revoke anytime.'}
        </p>
      )}

      {showForm && (
        <div className="space-y-3 mt-3">
          <p className="text-xs font-mono text-dim">
            Set a USDC budget — one approval in your Base Account.
          </p>
          <div className="flex gap-2 items-center">
            <span className="text-xs font-mono text-dim">$</span>
            <input
              value={amount}
              inputMode="decimal"
              placeholder="20"
              onChange={(e) => {
                const x = e.target.value
                if (x === '' || /^\d*\.?\d*$/.test(x)) setAmount(x)
              }}
              disabled={busy}
              className="w-20 bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
            />
            <select
              value={periodDays}
              onChange={(e) => setPeriodDays(Number(e.target.value))}
              disabled={busy}
              className="bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink disabled:opacity-50"
            >
              {PERIODS.map((p) => (
                <option key={p.days} value={p.days}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button
              onClick={grant}
              disabled={busy || !amount}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 btn-accent disabled:opacity-50"
            >
              {ac.phase === 'connecting'
                ? 'connecting…'
                : ac.phase === 'granting'
                  ? 'approving…'
                  : ac.budget
                    ? 'Update budget'
                    : 'Approve once'}
            </button>
            {ac.budget && (
              <button
                onClick={() => void ac.revoke()}
                disabled={busy}
                className="text-xs font-mono uppercase tracking-wider px-3 py-2 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
              >
                {ac.phase === 'revoking' ? 'turning off…' : 'Turn off'}
              </button>
            )}
          </div>
          {ac.error && <p className="text-[10px] font-mono text-dim italic">{ac.error}</p>}
        </div>
      )}
    </div>
  )
}
