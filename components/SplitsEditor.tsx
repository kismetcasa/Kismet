'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { isAddress } from 'viem'
import { shortAddress, type Split } from '@/lib/inprocess'
import { MAX_SPLITS } from '@/lib/splits'
import { RESIDENCIES_ADDRESS } from '@/lib/config'

// The mint form's revenue-splits editor (extracted from MintForm, which is
// its only host). Controlled: `splits` holds CUSTOM recipients only — the
// creator is never stored. Their share is the derived remainder, rendered as
// a permanent non-removable "you" row that auto-absorbs every add/edit/remove,
// so a total ≠ 100 is unrepresentable here (MintForm keeps submit-time
// backstops for state drift). Empty state shows a purpose line and nothing
// else — no percentages until a collaborator exists; the residencies cut
// surfaces through the mechanic + "mints as" lines the moment rows appear
// (and via the toggle below the mint button, which stays where it is).
interface SplitsEditorProps {
  splits: Split[]
  onChange: (next: Split[]) => void
  /** Connected wallet; undefined pre-connect (you-row shows a bare "you"). */
  creatorAddress?: string
  residenciesEnabled: boolean
  residenciesPercent: number
  residenciesOverCap: boolean
  /** 100 − sum of custom rows — the derived "you" share (from MintForm). */
  remainder: number
  /**
   * computeFinalSplits output when the final integers can differ from the
   * rows (residencies on + rows present + connected + not over-cap), else
   * null. Composed in MintForm from the SAME array the payload uses, so the
   * preview cannot drift from what actually mints.
   */
  preview: Split[] | null
}

export function SplitsEditor({
  splits,
  onChange,
  creatorAddress,
  residenciesEnabled,
  residenciesPercent,
  residenciesOverCap,
  remainder,
  preview,
}: SplitsEditorProps) {
  const [input, setInput] = useState({ address: '', pct: '' })
  // Inline % edit (same idiom as MintForm's residencies %): row address being
  // edited + its transient buffer, committed on blur/Enter, reverted on Escape.
  const [editingAddr, setEditingAddr] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState('')

  const typedPct = parseInt(input.pct, 10)
  // Live over-allocation state — surfaces BEFORE the click (the + disables,
  // hint below explains) instead of a surprise toast. Rows-only: with no rows
  // the remainder is 100 and the 1–100 add validation already covers it.
  const overAlloc = splits.length > 0 && Number.isFinite(typedPct) && typedPct > remainder
  // The one editor state with no valid payload: a lone recipient holding all
  // 100 (computeFinalSplits' residencies branch would silently DROP them, and
  // with residencies off a 1-recipient split can't exist on-chain).
  const soleFull = splits.length === 1 && remainder === 0

  function addSplit() {
    const addr = input.address.trim()
    const pct = typedPct
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) { toast.error('Allocation must be a whole number 1–100'); return }
    // Their share IS the derived row — adding it as a custom entry would
    // duplicate the address in the final array (the server rejects dups).
    if (creatorAddress && addr.toLowerCase() === creatorAddress.toLowerCase()) {
      toast.error('That’s you — your share is the "you" row, it adjusts automatically')
      return
    }
    // Backstop for the Enter-key path; the + button is disabled while overAlloc.
    if (pct > remainder) {
      toast.error(`Only ${remainder}% left — lower the % or remove a recipient`)
      return
    }
    // EVM addresses are case-insensitive but 0xSplits' SplitMain rejects
    // byte-level duplicates, so "0xABC" + "0xabc" would revert the deploy.
    const lowerAddr = addr.toLowerCase()
    if (splits.some((s) => s.address.toLowerCase() === lowerAddr)) {
      toast.error('Address already added')
      return
    }
    // When residencies is ON, the final array auto-appends RESIDENCIES_ADDRESS.
    // Letting the user add it manually creates a duplicate SplitMain rejects.
    if (residenciesEnabled && lowerAddr === RESIDENCIES_ADDRESS.toLowerCase()) {
      toast.error('Residencies is already on below — disable the toggle first to set its allocation manually')
      return
    }
    // Slot math against the server's MAX_SPLITS, counting the entries the
    // FINAL array will actually hold: the new row, the derived creator row
    // (only while a remainder survives this add), and residencies' slot.
    const finalCount =
      (splits.length + 1) + (remainder - pct > 0 ? 1 : 0) + (residenciesEnabled ? 1 : 0)
    if (finalCount > MAX_SPLITS) {
      toast.error(`Recipient limit reached — a split maxes out at ${MAX_SPLITS} entries including you${residenciesEnabled ? ' and residencies' : ''}`)
      return
    }
    onChange([...splits, { address: addr, percentAllocation: pct }])
    setInput({ address: '', pct: '' })
  }

  // Commit an inline % edit: integers only, clamped to what this row can hold
  // — its old share plus whatever the "you" row has left. Other rows never
  // move; the derived remainder absorbs the delta in both directions.
  function commitEdit(addr: string) {
    setEditingAddr(null)
    const row = splits.find((s) => s.address === addr)
    if (!row) return
    const raw = editBuffer.trim()
    const num = Number(raw)
    if (raw === '' || !Number.isFinite(num)) return
    const upper = remainder + row.percentAllocation
    const intval = Math.floor(num)
    const clamped = Math.min(upper, Math.max(1, intval))
    if (clamped !== intval) {
      toast.error(
        intval > upper
          ? `Only ${upper}% available for this recipient`
          : 'Minimum is 1% — remove the row instead',
      )
    }
    if (clamped === row.percentAllocation) return
    onChange(splits.map((s) => (s.address === addr ? { ...s, percentAllocation: clamped } : s)))
  }

  // "mints as" entries in reading order (you → rows as added → residencies),
  // values looked up from the computed array. On-chain order is address-
  // sorted; this order optimizes reading, the values are exact.
  const previewEntries: Array<{ label: string; pct: number }> = []
  if (preview) {
    const byAddr = new Map(preview.map((p) => [p.address.toLowerCase(), p.percentAllocation]))
    if (creatorAddress) {
      const mine = byAddr.get(creatorAddress.toLowerCase())
      if (mine !== undefined) previewEntries.push({ label: 'you', pct: mine })
    }
    for (const s of splits) {
      const pct = byAddr.get(s.address.toLowerCase())
      if (pct !== undefined) previewEntries.push({ label: shortAddress(s.address), pct })
    }
    const res = byAddr.get(RESIDENCIES_ADDRESS.toLowerCase())
    if (res !== undefined) previewEntries.push({ label: 'residencies', pct: res })
  }

  return (
    <div>
      <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-1">
        Revenue Splits
      </label>
      {/* Empty state stays percentage-free on purpose (product decision):
          the section explains its job and nothing more until a collaborator
          exists. */}
      {splits.length === 0 && (
        <p className="text-xs text-muted font-mono mb-2">
          split mint proceeds with collaborators
        </p>
      )}

      {splits.length > 0 && (
        <ul className="flex flex-col gap-1 mb-2">
          {/* Derived "you" row — non-removable, absorbs every change. Shows
              the pre-cut share (the editing currency); the mints-as line
              below carries the post-residencies truth. */}
          <li className="flex items-center justify-between bg-surface border border-line px-3 py-2">
            <span className="text-xs font-mono text-ink truncate">
              you{creatorAddress ? <span className="text-subtle"> {shortAddress(creatorAddress)}</span> : null}
            </span>
            <span className={`text-xs font-mono flex-shrink-0 ml-2 ${remainder === 0 ? 'text-subtle' : 'text-ink'}`}>
              {remainder}%
            </span>
          </li>
          {splits.map((s) => (
            <li key={s.address} className="flex items-center justify-between bg-surface border border-line px-3 py-2">
              <span className="text-xs font-mono text-dim truncate">{s.address}</span>
              <div className="flex items-center gap-3 ml-2 flex-shrink-0">
                {editingAddr === s.address ? (
                  <input
                    type="number"
                    autoFocus
                    value={editBuffer}
                    min={1}
                    max={remainder + s.percentAllocation}
                    step={1}
                    onChange={(e) => setEditBuffer(e.target.value)}
                    onBlur={() => commitEdit(s.address)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); commitEdit(s.address) }
                      else if (e.key === 'Escape') { e.preventDefault(); setEditingAddr(null) }
                    }}
                    aria-label={`Percent for ${shortAddress(s.address)}`}
                    className="w-12 bg-surface border border-line px-1 py-0.5 text-xs text-ink font-mono text-center focus:outline-none focus:border-muted [appearance:textfield]"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditBuffer(String(s.percentAllocation))
                      setEditingAddr(s.address)
                    }}
                    title="Click to edit this share"
                    className="text-xs font-mono text-ink underline decoration-dotted underline-offset-2 hover:text-accent transition-colors"
                  >
                    {s.percentAllocation}%
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onChange(splits.filter((r) => r.address !== s.address))}
                  aria-label={`Remove ${shortAddress(s.address)}`}
                  className="text-muted hover:text-dim"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* State sublines. soleFull is the only red one — it blocks the mint. */}
      {soleFull ? (
        <p className="text-xs font-mono text-red-500 mb-2">
          one recipient can’t take the full 100% — add another or lower theirs so you keep a share
        </p>
      ) : remainder === 0 && splits.length >= 2 ? (
        <p className="text-xs font-mono text-muted mb-2">
          you receive 0% — all revenue splits between the recipients above
        </p>
      ) : null}

      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={input.address}
          onChange={(e) => setInput((s) => ({ ...s, address: e.target.value }))}
          placeholder="0x… address"
          className="flex-1 bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
        <input
          type="text"
          inputMode="numeric"
          value={input.pct}
          onChange={(e) => {
            // Integers only — the server has always required whole percents
            // (validateSplitsArray); fractions used to be silently rounded.
            const v = e.target.value
            if (v === '' || /^[1-9]\d*$/.test(v)) setInput((s) => ({ ...s, pct: v }))
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSplit() } }}
          placeholder="%"
          className="w-16 bg-surface border border-line px-2 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
        <button
          type="button"
          onClick={addSplit}
          disabled={overAlloc}
          aria-label="Add split recipient"
          className="px-3 border border-line text-dim hover:border-muted hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={14} />
        </button>
      </div>
      {overAlloc && (
        <p className="text-xs font-mono text-red-500 mb-2">
          only {remainder}% left — lower the % or remove a recipient
        </p>
      )}

      {/* Residencies echo — the toggle itself stays below the mint button
          (settled product decision, commit 2910e74); these lines make its
          effect visible where splits are edited. */}
      {residenciesEnabled && splits.length > 0 && (
        <p className="text-xs font-mono text-muted">
          residencies takes {residenciesPercent}% off the top — shares scale to the
          remaining {100 - residenciesPercent}%, in whole percents
        </p>
      )}
      {previewEntries.length > 0 ? (
        <p className="text-xs font-mono text-muted mt-1" aria-live="polite">
          <span className="text-subtle">mints as:</span>{' '}
          {previewEntries.map((e, i) => (
            <span key={`${e.label}-${i}`} className="text-dim">
              {i > 0 && <span className="text-subtle"> · </span>}
              {e.label} {e.pct}%
            </span>
          ))}
        </p>
      ) : residenciesEnabled && splits.length > 0 && residenciesOverCap ? (
        <p className="text-xs font-mono text-muted mt-1">
          fix the residencies % below to see the final split
        </p>
      ) : null}
    </div>
  )
}
