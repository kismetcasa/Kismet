'use client'

/**
 * Agent Collect — setup + management (owner profile, smart-wallet only).
 *
 * The Phase 2 surface: the user picks artists to watch + a budget; one approval
 * grants a bounded Spend Permission to KISMET's server spender; thereafter the
 * agent collects their new drops, tap-free, within the on-chain cap. Runs on open
 * + on demand. Gated by useAgent → useSmartWalletAgentEligibility (EOAs see a soft
 * note). Mounted (code-split, ssr:false) in ProfileView's owner section.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { formatUnits, isAddress } from 'viem'
import { useAgent, type AgentConfigInput, type WatchedArtist } from '@/hooks/useAgent'

const PERIODS = [
  { label: 'per day', days: 1 },
  { label: 'per week', days: 7 },
  { label: 'per month', days: 30 },
] as const

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const label = (a: WatchedArtist) => a.username || short(a.address)

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="border border-line p-4 space-y-2">
      <h3 className="text-xs font-mono uppercase tracking-wider text-ink">Agent Collect</h3>
      {children}
    </div>
  )
}

export function AgentCollectPanel() {
  const ag = useAgent()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  // Setup form state.
  const [artists, setArtists] = useState<WatchedArtist[]>([])
  const [artistInput, setArtistInput] = useState('')
  const [results, setResults] = useState<WatchedArtist[]>([])
  const [searching, setSearching] = useState(false)
  const [currency, setCurrency] = useState<'eth' | 'usdc'>('eth')
  const [amount, setAmount] = useState('')
  const [periodDays, setPeriodDays] = useState<number>(7)
  const [maxItem, setMaxItem] = useState('')
  const [maxItems, setMaxItems] = useState('5')
  // Mode: 'patron' = collect 1 of each new drop; 'editions' = collect up to N
  // of each (same budget/cap, different config). Drives maxEditionsPerDrop.
  const [mode, setMode] = useState<'patron' | 'editions'>('patron')
  const [editions, setEditions] = useState('3')

  const busy = ag.running || saving
  const typedIsAddress = isAddress(artistInput.trim())
  const sym = currency === 'eth' ? 'Ξ' : '$'
  const scoutCur = ag.scout?.budget.currency ?? 'usdc'
  const scoutDec = scoutCur === 'eth' ? 18 : 6
  const scoutSym = scoutCur === 'eth' ? 'Ξ' : '$'

  // Debounced username→artist search (skip when the input is already an address).
  useEffect(() => {
    const q = artistInput.trim()
    if (q.length < 2 || isAddress(q)) {
      setResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
        if (r.ok) {
          const d = (await r.json()) as { users?: Array<{ address?: string; username?: string }> }
          if (!cancelled) {
            setResults(
              (d.users ?? [])
                .filter((u) => u.address && isAddress(u.address))
                .slice(0, 6)
                .map((u) => ({ address: u.address!.toLowerCase(), username: u.username || undefined })),
            )
          }
        }
      } catch {
        /* ignore; user can paste an address */
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [artistInput])

  if (ag.loading) return null

  if (!ag.eligible) {
    return (
      <Shell>
        <p className="text-xs font-mono text-dim leading-relaxed">
          Watch your favorite artists and automatically collect their drops within a budget — available with a
          Base Account (smart wallet). Open Kismet in the Base App to enable it.
        </p>
      </Shell>
    )
  }

  if (!ag.configured) {
    return (
      <Shell>
        <p className="text-xs font-mono text-dim leading-relaxed">
          Agent Collect is coming soon. In the meantime you can collect, buy, and list from your
          AI assistant — see <a href="/agent" className="text-accent hover:underline">the agent page</a>.
        </p>
      </Shell>
    )
  }

  function addArtist(a: WatchedArtist) {
    if (!isAddress(a.address) || artists.some((x) => x.address === a.address)) return
    setArtists((xs) => [...xs, a])
    setArtistInput('')
    setResults([])
  }

  async function save() {
    const v = parseFloat(amount)
    const mi = parseFloat(maxItem)
    const n = parseInt(maxItems, 10)
    const ed = mode === 'editions' ? parseInt(editions, 10) : 1
    if (artists.length === 0 || !amount || Number.isNaN(v) || v <= 0) return
    if (!maxItem || Number.isNaN(mi) || mi <= 0 || !Number.isInteger(n) || n < 1) return
    if (mode === 'editions' && (!Number.isInteger(ed) || ed < 1 || ed > 10)) return
    const cfg: AgentConfigInput = {
      artists,
      currency,
      allowance: amount,
      periodInDays: periodDays,
      maxItemPrice: maxItem,
      maxItemsPerPeriod: n,
      maxEditionsPerDrop: ed,
    }
    setSaving(true)
    try {
      await ag.save(cfg)
      setEditing(false)
    } catch {
      // surfaced via ag.error
    } finally {
      setSaving(false)
    }
  }

  function startEdit() {
    if (ag.scout) {
      const cur = ag.scout.budget.currency
      const dec = cur === 'eth' ? 18 : 6
      setCurrency(cur)
      setArtists(ag.scout.policy.creators.map((addr) => ({ address: addr, username: ag.artistLabels?.[addr] })))
      setAmount(formatUnits(BigInt(ag.scout.budget.allowance), dec))
      setPeriodDays(Math.max(1, Math.round(ag.scout.budget.periodSeconds / 86_400)))
      setMaxItem(formatUnits(BigInt(ag.scout.policy.maxItemPrice), dec))
      setMaxItems(String(ag.scout.policy.maxItemsPerPeriod))
      const ed = ag.scout.policy.maxEditionsPerDrop ?? 1
      setMode(ed > 1 ? 'editions' : 'patron')
      setEditions(String(ed > 1 ? ed : 3))
    }
    setEditing(true)
  }

  const active = ag.scout?.status === 'active'
  const showForm = !ag.scout || editing
  const watching = ag.scout
    ? ag.scout.policy.creators.map((a) => ag.artistLabels?.[a] || short(a)).join(', ')
    : ''

  return (
    <div className="border border-line p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink">Agent Collect</h3>
        {ag.scout && !editing && (
          <button
            onClick={() => void ag.setActive(!active)}
            disabled={busy}
            className="text-[10px] font-mono uppercase tracking-wider text-dim hover:text-accent transition-colors disabled:opacity-50"
          >
            {active ? 'pause' : 'resume'}
          </button>
        )}
      </div>

      {/* ── Active status ───────────────────────────────────────────── */}
      {ag.scout && !editing && (
        <>
          <p className="text-xs font-mono text-dim leading-relaxed">
            {active ? 'Watching ' : 'Paused — '}
            {watching || `${ag.scout.policy.creators.length} artists`}
            {ag.status
              ? ag.status.isActive
                ? ` · ${scoutSym}${formatUnits(ag.status.remainingSpend, scoutDec)} left · resets ${ag.status.nextPeriodStart.toLocaleDateString()}`
                : ' · budget inactive — set it again'
              : ''}
          </p>

          {ag.lastRun ? (
            <p className="text-[10px] font-mono text-faint leading-relaxed">
              {ag.running
                ? 'Checking your artists…'
                : ag.lastRun.collected > 0
                  ? `Last run: collected ${ag.lastRun.collected}${ag.lastRun.skipped ? `, skipped ${ag.lastRun.skipped}` : ''}.`
                  : `Last run: ${ag.lastRun.reason ?? 'nothing to collect'}.`}
            </p>
          ) : active ? (
            <p className="text-[10px] font-mono text-faint leading-relaxed">
              {ag.running ? 'Checking your artists…' : 'Runs automatically each time you open Kismet.'}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void ag.runNow()}
              disabled={busy || !active}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 btn-accent disabled:opacity-50"
            >
              {ag.running ? 'collecting…' : 'Run now'}
            </button>
            <button
              onClick={startEdit}
              disabled={busy}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            >
              Edit
            </button>
            <button
              onClick={() => void ag.remove()}
              disabled={busy}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
            >
              Turn off
            </button>
          </div>
        </>
      )}

      {/* ── Setup / edit form ───────────────────────────────────────── */}
      {showForm && (
        <div className="space-y-3">
          {/* Mode: two ways to set up, one budget. Patron = 1 of each new drop;
              Editions = up to N of each. Same engine, different config. */}
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-2">
              {(['patron', 'editions'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  disabled={busy}
                  className={`text-left px-2.5 py-2 border transition-colors disabled:opacity-50 ${mode === m ? 'border-accent' : 'border-line hover:border-muted'}`}
                >
                  <div className={`text-[11px] font-mono uppercase tracking-wider ${mode === m ? 'text-accent' : 'text-dim'}`}>
                    {m === 'patron' ? 'Patron' : 'Editions'}
                  </div>
                  <div className="text-[10px] font-mono text-faint leading-snug mt-0.5">
                    {m === 'patron' ? '1 of each new drop' : 'up to N of each drop'}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <p className="text-xs font-mono text-dim leading-relaxed">
            {mode === 'patron'
              ? 'Patronize your favorite artists over time — one approval and the agent collects 1 of each new drop, within your budget. Your Base Account funds and receives; revoke anytime.'
              : 'Automatically collect up to your set editions of each drop the moment it lands, within your budget — fairly shared if a drop is contended. Your Base Account funds and receives; revoke anytime.'}
          </p>

          {/* Artists */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Watch artists</label>
            <div className="relative">
              <div className="flex gap-2">
                <input
                  value={artistInput}
                  placeholder="search a username, or paste 0x…"
                  onChange={(e) => setArtistInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (typedIsAddress) addArtist({ address: artistInput.trim().toLowerCase() })
                      else if (results[0]) addArtist(results[0])
                    }
                  }}
                  disabled={busy}
                  className="flex-1 bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
                />
                <button
                  onClick={() => typedIsAddress && addArtist({ address: artistInput.trim().toLowerCase() })}
                  disabled={busy || !typedIsAddress}
                  title={typedIsAddress ? 'Add this address' : 'Search by username, then pick a result'}
                  className="text-xs font-mono uppercase tracking-wider px-3 py-1.5 border border-line text-dim hover:border-accent hover:text-accent transition-colors disabled:opacity-40"
                >
                  add
                </button>
              </div>

              {!typedIsAddress && artistInput.trim().length >= 2 && (searching || results.length > 0) && (
                <div className="absolute z-10 left-0 right-0 mt-1 bg-surface border border-line max-h-44 overflow-y-auto">
                  {searching && results.length === 0 ? (
                    <div className="px-2 py-2 text-[10px] font-mono text-faint">searching…</div>
                  ) : (
                    results.map((u) => (
                      <button
                        key={u.address}
                        onClick={() => addArtist(u)}
                        disabled={artists.some((x) => x.address === u.address)}
                        className="w-full text-left px-2 py-1.5 text-xs font-mono text-ink hover:bg-raised transition-colors disabled:opacity-40 flex items-center justify-between gap-2"
                      >
                        <span className="truncate">{u.username || short(u.address)}</span>
                        <span className="text-[10px] text-faint shrink-0">{short(u.address)}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            {artists.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {artists.map((a) => (
                  <span
                    key={a.address}
                    className="inline-flex items-center gap-1 text-[10px] font-mono text-dim border border-line px-1.5 py-0.5"
                  >
                    {label(a)}
                    <button
                      onClick={() => setArtists((xs) => xs.filter((x) => x.address !== a.address))}
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
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Budget</label>
              <div className="flex gap-1">
                {(['eth', 'usdc'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => setCurrency(c)}
                    disabled={busy}
                    className={`text-[10px] font-mono uppercase px-1.5 py-0.5 border transition-colors disabled:opacity-50 ${currency === c ? 'border-accent text-accent' : 'border-line text-dim hover:text-dim'}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2 items-center">
              <span className="text-xs font-mono text-dim">{sym}</span>
              <input
                value={amount}
                inputMode="decimal"
                placeholder={currency === 'eth' ? '0.01' : '20'}
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
                <span className="text-xs font-mono text-dim">{sym}</span>
                <input
                  value={maxItem}
                  inputMode="decimal"
                  placeholder={currency === 'eth' ? '0.005' : '5'}
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
            {mode === 'editions' && (
              <div className="space-y-1.5">
                <label className="text-[10px] font-mono uppercase tracking-wider text-dim">Editions / drop</label>
                <input
                  value={editions}
                  inputMode="numeric"
                  placeholder="3"
                  onChange={(e) => {
                    const x = e.target.value
                    if (x === '' || /^\d*$/.test(x)) setEditions(x)
                  }}
                  disabled={busy}
                  title="Up to how many of each drop to collect (1–10)"
                  className="w-16 bg-surface border border-line px-2 py-1.5 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
                />
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || artists.length === 0 || !amount || !maxItem || (mode === 'editions' && !editions)}
              className="text-xs font-mono uppercase tracking-wider px-3 py-2 btn-accent disabled:opacity-50"
            >
              {saving ? 'approving…' : ag.scout ? 'Save' : 'Approve & start'}
            </button>
            {ag.scout && (
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

      {ag.error && <p className="text-[10px] font-mono text-dim italic">{ag.error}</p>}
    </div>
  )
}
