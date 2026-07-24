'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { isAddress } from 'viem'
import { shortAddress, type Split } from '@/lib/inprocess'
import { MAX_SPLITS } from '@/lib/splits'
import { RESIDENCIES_ADDRESS } from '@/lib/config'
import { ProfileAvatar } from './ProfileAvatar'
import { fetchCreatorProfile } from '@/lib/profileCache'

// A recipient's resolved Kismet identity — display name (username / farcaster
// / ENS, server-collapsed) and avatar. `name` is undefined when the address
// has no Kismet profile (fetchCreatorProfile returns its shortAddress
// fallback, which we treat as "no identity" so the row falls back to the raw
// address the artist can verify).
interface Identity {
  name?: string
  avatarUrl?: string
}

// The mint form's revenue-splits editor (extracted from MintForm, which is
// its only host). Controlled: `splits` holds COLLABORATORS only — the creator
// is never stored. Collaborators receive the exact percent typed; the
// residencies donation (when on) comes out of the creator's share; the creator
// receives the remainder, shown as a permanent non-removable "you" row that
// already nets out residencies. Because the model is subtraction (no scaling),
// the rows are byte-for-byte what mints — no preview line needed. A total ≠ 100
// is unrepresentable here; MintForm keeps submit-time backstops for state
// drift. Empty state shows a purpose line and nothing else — no percentages
// until a collaborator exists; residencies stays on its toggle below the mint
// button.
//
// Each row resolves the recipient's Kismet profile (pfp + display name) via
// the shared LRU cache — the same call SplitsPanel makes on artwork pages, so
// one cheap deduped GET per unique address. A recipient with no Kismet profile
// shows their full address instead; every row shows the full address for
// on-chain verification regardless.
interface SplitsEditorProps {
  splits: Split[]
  onChange: (next: Split[]) => void
  /** Connected wallet; undefined pre-connect (you-row shows a bare "you"). */
  creatorAddress?: string
  residenciesEnabled: boolean
  /**
   * The derived "you" share: 100 − collaborators − residencies cut (from
   * MintForm). Drives the you-row, auto-absorb, over-allocation, and edit
   * clamps — all measured against what's left for the creator.
   */
  remainder: number
}

export function SplitsEditor({
  splits,
  onChange,
  creatorAddress,
  residenciesEnabled,
  remainder,
}: SplitsEditorProps) {
  const [input, setInput] = useState({ address: '', pct: '' })
  // Inline % edit (same idiom as MintForm's residencies %): row address being
  // edited + its transient buffer, committed on blur/Enter, reverted on Escape.
  const [editingAddr, setEditingAddr] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState('')

  // Resolved profiles keyed by lowercased address (you-row + each collaborator).
  const [profiles, setProfiles] = useState<Record<string, Identity>>({})
  // Re-runs only when the SET of addresses changes (not on % edits), so a
  // rename or reorder doesn't refetch. fetchCreatorProfile is LRU-cached +
  // deduped, so even a re-run is a cache hit with no network.
  const addrKey = [creatorAddress ?? '', ...splits.map((s) => s.address)].join(',').toLowerCase()
  useEffect(() => {
    const addrs = [creatorAddress, ...splits.map((s) => s.address)].filter(
      (a): a is string => !!a,
    )
    let cancelled = false
    for (const a of addrs) {
      void fetchCreatorProfile(a).then(({ name, avatarUrl }) => {
        if (cancelled) return
        // fetchCreatorProfile returns shortAddress as `name` when unresolved;
        // treat that as "no identity" so the row shows the full address.
        const resolvedName = name && name !== shortAddress(a) ? name : undefined
        setProfiles((prev) => ({ ...prev, [a.toLowerCase()]: { name: resolvedName, avatarUrl } }))
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addrKey])

  const typedPct = parseInt(input.pct, 10)
  // Live over-allocation state — surfaces BEFORE the click (the + disables,
  // hint below explains) instead of a surprise toast. Rows-only: with no rows
  // the remainder is what's left for you and the 1–100 add validation covers it.
  const overAlloc = splits.length > 0 && Number.isFinite(typedPct) && typedPct > remainder
  // The one editor state with no valid payload: a lone collaborator taking all
  // 100 with residencies OFF (a 1-recipient split can't exist on-chain, and
  // computeFinalSplits returns undefined → 100% would misroute to the creator).
  // With residencies ON, the lone collaborator pairs with the residencies
  // recipient into a valid 2-entry split, so it's allowed.
  const soleFull = splits.length === 1 && remainder === 0 && !residenciesEnabled

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
              your true take: 100 − collaborators − residencies, i.e. exactly
              what mints. */}
          <li className="flex items-center justify-between bg-surface border border-line px-3 py-2 gap-2">
            <RecipientIdentity
              address={creatorAddress}
              profile={creatorAddress ? profiles[creatorAddress.toLowerCase()] : undefined}
              isYou
            />
            <span className={`text-xs font-mono flex-shrink-0 ${remainder === 0 ? 'text-subtle' : 'text-ink'}`}>
              {remainder}%
            </span>
          </li>
          {splits.map((s) => (
            <li key={s.address} className="flex items-center justify-between bg-surface border border-line px-3 py-2 gap-2">
              <RecipientIdentity address={s.address} profile={profiles[s.address.toLowerCase()]} />
              <div className="flex items-center gap-3 flex-shrink-0">
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
          you receive 0% — all proceeds go to the recipients above
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
    </div>
  )
}

// The left cell of a recipient row. Every recipient shows an avatar — their
// Kismet pfp when they have one, otherwise the address-derived gradient
// ProfileAvatar always paints. With a display name, the name sits on top and
// the full address beneath for verification; with no display name, the full
// address takes the name's place. The creator's own row (`isYou`) carries a
// "· you" marker.
function RecipientIdentity({
  address,
  profile,
  isYou = false,
}: {
  address?: string
  profile?: Identity
  isYou?: boolean
}) {
  // Pre-connect creator row: no address to resolve or verify yet.
  if (!address) {
    return <span className="text-xs font-mono text-ink">you</span>
  }
  const name = profile?.name
  const youTag = isYou ? <span className="text-subtle"> · you</span> : null
  return (
    <div className="flex items-center gap-2 min-w-0">
      <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={22} />
      {name ? (
        // Named: name on top, full address beneath to verify.
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-mono text-ink truncate">{name}{youTag}</span>
          <span className="text-[10px] font-mono text-subtle break-all leading-tight">{address}</span>
        </div>
      ) : (
        // No display name: the address stands in for it. break-all keeps a long
        // hex string from overflowing the row on narrow screens.
        <span className="text-xs font-mono text-dim break-all min-w-0">{address}{youTag}</span>
      )}
    </div>
  )
}
