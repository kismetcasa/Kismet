'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { shortAddress } from '@/lib/inprocess'
import { useFarcaster } from '@/providers/FarcasterProvider'

interface Wallet {
  address: string
  isPrimary: boolean
  isIdentity: boolean
}

// Mini-App-only chooser for which of the user's FC-verified addresses
// is the "Kismet identity" — the address that drives their public
// profile URL, display name, share cards, and Nav avatar.
//
// Renders nothing when:
//   - Not inside a Mini App (web users have a single wallet, no choice)
//   - User has < 2 verified addresses (nothing to choose)
//   - /api/me fails (we degrade gracefully — the picker is optional,
//     sibling inheritance already covers the common case)
//
// No signature required from the user when switching — FC's
// verification system already proved they own every address in the
// list, so the server-side membership check is sufficient.
export function WalletsPanel() {
  const { isInMiniApp, refreshIdentity } = useFarcaster()
  const [wallets, setWallets] = useState<Wallet[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    if (!isInMiniApp) { setLoading(false); return }
    let cancelled = false
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { wallets?: Wallet[] }) => {
        if (cancelled) return
        setWallets(Array.isArray(d.wallets) ? d.wallets : [])
      })
      .catch(() => {
        if (cancelled) return
        setWallets([])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [isInMiniApp])

  if (!isInMiniApp) return null
  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={14} className="animate-spin text-muted" />
      </div>
    )
  }
  // Nothing to pick — either we couldn't load wallets, or the user
  // has only one verification. Hide the section entirely rather than
  // render a one-row picker that looks like a placeholder.
  if (!wallets || wallets.length < 2) return null

  async function pick(addr: string) {
    if (saving) return
    setSaving(addr)
    try {
      const res = await fetch('/api/me/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }))
        throw new Error(body.error || 'Could not update Kismet address')
      }
      // Optimistically reflect the change in the local list before the
      // /api/me refresh lands — the radio dot flips instantly.
      setWallets((prev) =>
        prev
          ? prev.map((w) => ({ ...w, isIdentity: w.address === addr }))
          : prev,
      )
      // Push the new address through Nav + everywhere else that reads
      // fcIdentity from context.
      await refreshIdentity()
      toast.success('Kismet address updated', { id: 'identity' })
    } catch (err) {
      toast.error((err as Error).message, { id: 'identity' })
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-mono text-muted uppercase tracking-wider">
        Kismet Address
      </label>
      <p className="text-[10px] font-mono text-faint -mt-0.5 mb-1.5">
        Which Farcaster-verified wallet represents you on Kismet.
      </p>
      <div className="flex flex-col">
        {wallets.map((w) => {
          const isSelected = w.isIdentity
          const isSaving = saving === w.address
          return (
            <button
              key={w.address}
              onClick={() => pick(w.address)}
              disabled={isSelected || !!saving}
              className={`flex items-center gap-3 px-3 py-2.5 border text-left transition-colors ${
                isSelected
                  ? 'border-accent bg-accent/10 cursor-default'
                  : 'border-line hover:bg-[#1e1e1e] disabled:cursor-wait'
              } ${wallets!.indexOf(w) > 0 ? '-mt-px' : ''}`}
            >
              {/* Custom radio so we control the active color. The
                  outer ring is muted when unselected, accent when
                  selected; the inner dot only appears when selected. */}
              <span
                aria-hidden
                className={`w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center ${
                  isSelected ? 'border-accent' : 'border-muted'
                }`}
              >
                {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
              </span>
              <span className="flex-1 min-w-0 font-mono text-xs text-ink truncate">
                {shortAddress(w.address)}
              </span>
              {w.isPrimary && (
                <span className="text-[9px] font-mono uppercase tracking-widest text-muted flex-shrink-0">
                  primary
                </span>
              )}
              {isSaving && (
                <Loader2 size={11} className="animate-spin text-muted flex-shrink-0" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
