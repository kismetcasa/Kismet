'use client'

/**
 * Auto-collect Scout — setup + management (owner profile, smart-wallet only).
 *
 * The user-facing surface for the budgeted, artist-watching auto-collect agent
 * (Mode A). The user picks artists to watch, a USDC budget, and per-item / per-
 * period caps; the agent then collects new drops from those artists, popup-less,
 * within the on-chain Spend Permission. Runs on open (auto) and on demand.
 *
 * Gated by useScout → useSmartWalletAgentEligibility: EOAs can't grant the Spend
 * Permission a scout needs, so they see only a soft note and the per-action
 * collect/buy/list flows stay exactly as they are. Mounted (code-split,
 * ssr:false) in ProfileView's owner section. Live behavior needs a Base Account
 * smoke test (no wallet/RPC in CI).
 */

import { useState } from 'react'
import { formatUnits, isAddress } from 'viem'
import { useScout, type ScoutConfigInput } from '@/hooks/useScout'

const PERIODS = [
  { label: 'per day', days: 1 },
  { label: 'per week', days: 7 },
  { label: 'per month', days: 30 },
] as const

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function AutoCollectPanel() {
  const sc = useScout()
  const [editing, setEditing] = useState(false)

  // Setup form state.
  const [artists, setArtists] = useState<string[]>([])
  const [artistInput, setArtistInput] = useState('')
  const [amount, setAmount] = useState('')
  const [periodDays, setPeriodDays] = useState<number>(7)
  const [maxItem, setMaxItem] = useState('')
  const [maxItems, setMaxItems] = useState('5')

  const busy = sc.running || sc.ac.phase !== 'idle'

  if (sc.loading) return null

  if (!sc.eligible) {
    return (
      <div className="border border-line p-4">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink mb-1">Auto-collect agent</h3>
        <p className="text-xs font-mono text-dim leading-relaxed">
          Watch your favorite artists and auto-collect their drops within a budget — available with a
          Base Account (smart wallet). Open Kismet in the Base App to enable it.
        </p>
      </div>
    )
  }

  function addArtist() {
    const a = artistInput.trim().toLowerCase()
    if (!isAddress(a) || artists.includes(a)) return
    setArtists((xs) => [...xs, a])
    setArtistInput('')
  }

  async function save() {
    const v = parseFloat(amount)
    const mi = parseFloat(maxItem)
    const n = parseInt(maxItems, 10)
    if (artists.length === 0 || !amount || Number.isNaN(v) || v <= 0) return
    if (!maxItem || Number.isNaN(mi) || mi <= 0 || !Number.isInteger(n) || n < 1) return
    const cfg: ScoutConfigInput = {
      creators: artists,
      allowanceUsdc: amount,
      periodInDays: periodDays,
      maxItemPriceUsdc: maxItem,
      maxItemsPerPeriod: n,
    }
    try {
      await sc.saveConfig(cfg)
      setEditing(false)
    } catch {
      // surfaced via sc.error
    }
  }

  // Prefill the form from an existing scout when editing.
  function startEdit() {
    if (sc.scout) {
      setArtists(sc.scout.policy.creators)
      setAmount(formatUnits(BigInt(sc.scout.budget.allowance), 6))
      setPeriodDays(Math.max(1, Math.round(sc.scout.budget.periodSeconds / 86_400)))
      setMaxItem(formatUnits(BigInt(sc.scout.policy.maxItemPrice), 6))
      setMaxItems(String(sc.scout.policy.maxItemsPerPeriod))
    }
    setEditing(true)
  }

  const status = sc.ac.status
  const active = sc.scout?.status === 'active'
  const showForm = !sc.scout || editing

  return (
    <div className="border border-line p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink">Auto-collect agent</h3>
        {sc.scout && !editing && (
          <button
            onClick={() => void sc.setActive(!active)}
            disabled={busy}
            className="text-[10px] font-mono uppercase tracking-wider text-dim hover:text-accent transition-colors disabled:opacity-50"
          >
            {active ? 'pause' : 'resume'}
          </button>
        )}
      </div>

      {/* ── Active status ───────────────────────────────────────────── */}
      {sc.scout && !editing && (
        <>
          <p className="text-xs font-mono text-dim leading-relaxed">
            {active ? 'Watching' : 'Paused —'} {sc.scout.policy.creators.length} artist
            {sc.scout.policy.creators.length === 1 ? '' : 's'}
            {status ? ` · $${formatUnits(status.remainingSpend, 6)} left · resets ${status.nextPeriodStart.toLocaleDateString()}` : ''}
          </p>

          {sc.lastRun && (
            <p className="text-[10px] font-mono text-faint leading-relaxed">
              {sc.running
                ? 'Checking your artists…'
                : sc.lastRun.collected > 0
                  ? `Last run: collected ${sc.lastRun.collected}${sc.lastRun.skipped ? `, skipped ${sc.lastRun.skipped}` : ''}.`
                  : `Last run: ${sc.lastRun.reason ?? 'nothing to collect'}.`}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void sc.run()}
              disabled={busy || !active}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 btn-accent disabled:opacity-50"
            >
              {sc.running ? 'collecting…' : 'Run now'}
            </button>
            <button
              onClick={startEdit}
              disabled={busy}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            >
              Edit
            </button>
            {sc.ac.budget && (
              <button
                onClick={() => void sc.ac.revoke()}
                disabled={busy}
                className="text-xs font-mono uppercase tracking-wider px-3 py-2 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
              >
                {sc.ac.phase === 'revoking' ? 'turning off…' : 'Turn off'}
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Setup / edit form ───────────────────────────────────────── */}
      {showForm && (
        <div className="space-y-3">
          <p className="text-xs font-mono text-dim leading-relaxed">
            Pick artists to watch and a budget. The agent collects their new drops, tap-free, up to
            your caps. Your Base Account pays and receives; revoke anytime.
          </p>

          {/* Artists */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Watch artists</label>
            <div className="flex gap-2">
              <input
                value={artistInput}
                placeholder="0x… artist address"
                onChange={(e) => setArtistInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addArtist()
                  }
                }}
                disabled={busy}
                className="flex-1 bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
              />
              <button
                onClick={addArtist}
                disabled={busy || !isAddress(artistInput.trim())}
                className="text-xs font-mono uppercase tracking-wider px-3 py-1.5 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-40"
              >
                add
              </button>
            </div>
            {artists.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {artists.map((a) => (
                  <span
                    key={a}
                    className="inline-flex items-center gap-1 text-[10px] font-mono text-dim border border-line px-1.5 py-0.5"
                  >
                    {short(a)}
                    <button
                      onClick={() => setArtists((xs) => xs.filter((x) => x !== a))}
                      disabled={busy}
                      className="text-faint hover:text-accent transition-colors disabled:opacity-50"
                      aria-label="remove"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Budget */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Budget (USDC)</label>
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
          </div>

          {/* Caps */}
          <div className="flex gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Max per item</label>
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-dim">$</span>
                <input
                  value={maxItem}
                  inputMode="decimal"
                  placeholder="5"
                  onChange={(e) => {
                    const x = e.target.value
                    if (x === '' || /^\d*\.?\d*$/.test(x)) setMaxItem(x)
                  }}
                  disabled={busy}
                  className="w-16 bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Items / period</label>
              <input
                value={maxItems}
                inputMode="numeric"
                placeholder="5"
                onChange={(e) => {
                  const x = e.target.value
                  if (x === '' || /^\d*$/.test(x)) setMaxItems(x)
                }}
                disabled={busy}
                className="w-16 bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || artists.length === 0 || !amount || !maxItem}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 btn-accent disabled:opacity-50"
            >
              {sc.ac.phase === 'connecting'
                ? 'connecting…'
                : sc.ac.phase === 'granting'
                  ? 'approving…'
                  : sc.scout
                    ? 'Save'
                    : 'Approve & start'}
            </button>
            {sc.scout && (
              <button
                onClick={() => setEditing(false)}
                disabled={busy}
                className="text-xs font-mono uppercase tracking-wider px-3 py-2 border border-line text-dim hover:border-dim transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {sc.error && <p className="text-[10px] font-mono text-dim italic">{sc.error}</p>}
    </div>
  )
}
