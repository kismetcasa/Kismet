'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { shortAddress } from '@/lib/inprocess'
import { useFarcaster } from '@/providers/FarcasterProvider'

interface Wallet {
  address: string
  isPrimary: boolean
  isIdentity: boolean
}

// Mini-App chooser for which of the user's FC-verified addresses is
// the "Kismet identity" — drives the public profile URL, display
// name, share cards, Nav avatar.
//
// Renders nothing when:
//   - Not inside a Mini App (web users have a single connected wallet)
//   - User has < 2 verified addresses (nothing to choose)
//   - /api/me fails (degrade gracefully — picker is optional)
//
// Switches go through a confirmation popup rather than firing on tap.
// Use case: a user whose current canonical wallet is compromised can
// switch to a different verified wallet without losing their FC
// identity. The deliberate step prevents accidental switches caused
// by a stray tap on the address list.
//
// No wallet signature required — FC's verification system already
// proved ownership of every address in the list; the server-side
// membership check in /api/me/identity is sufficient.
export function WalletsPanel() {
  const { isInMiniApp, refreshIdentity } = useFarcaster()
  const [wallets, setWallets] = useState<Wallet[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [pendingPick, setPendingPick] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // Fetch wallets from /api/me. When force=true, appends ?refresh=1 so
  // the server bypasses its FC-API caches — used by the refresh button
  // for users who just verified a new wallet on Farcaster. Returns the
  // wallet list rather than calling setState so the useEffect below
  // can drop the result safely when the component unmounted mid-fetch.
  const loadWallets = useCallback(async (force: boolean): Promise<Wallet[]> => {
    try {
      const res = await fetch(force ? '/api/me?refresh=1' : '/api/me')
      if (!res.ok) return []
      const d = (await res.json()) as { wallets?: Wallet[] }
      return Array.isArray(d.wallets) ? d.wallets : []
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    if (!isInMiniApp) { setLoading(false); return }
    let cancelled = false
    loadWallets(false).then((fresh) => {
      if (cancelled) return
      setWallets(fresh)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [isInMiniApp, loadWallets])

  async function refreshWallets() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const fresh = await loadWallets(true)
      setWallets(fresh)
    } finally {
      setRefreshing(false)
    }
  }

  if (!isInMiniApp) return null
  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 size={14} className="animate-spin text-muted" />
      </div>
    )
  }
  if (!wallets || wallets.length < 2) return null

  async function commitPick(addr: string) {
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
      // Optimistic local update so the radio dot flips before the
      // /api/me refresh lands.
      setWallets((prev) =>
        prev
          ? prev.map((w) => ({ ...w, isIdentity: w.address === addr }))
          : prev,
      )
      // Push the new address through Nav + everywhere else reading
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
    <>
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
                onClick={() => setPendingPick(w.address)}
                disabled={isSelected || !!saving}
                className={`flex items-center gap-3 px-3 py-2.5 border text-left transition-colors ${
                  isSelected
                    ? 'border-accent bg-accent/10 cursor-default'
                    : 'border-line hover:bg-[#1e1e1e] disabled:cursor-wait'
                } ${wallets!.indexOf(w) > 0 ? '-mt-px' : ''}`}
              >
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
        {/* Escape hatch for the 1h verification cache: a user who just
            FC-verified a new wallet sees it here immediately instead of
            waiting for the TTL to expire. */}
        <button
          onClick={refreshWallets}
          disabled={refreshing}
          className="self-start flex items-center gap-1.5 mt-2 text-[10px] font-mono text-faint hover:text-muted transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'refreshing…' : 'refresh wallets'}
        </button>
      </div>

      {pendingPick && typeof document !== 'undefined' && createPortal(
        <ConfirmSwitch
          address={pendingPick}
          onCancel={() => setPendingPick(null)}
          onConfirm={async () => {
            const addr = pendingPick
            setPendingPick(null)
            await commitPick(addr)
          }}
        />,
        document.body,
      )}
    </>
  )
}

function ConfirmSwitch({
  address,
  onCancel,
  onConfirm,
}: {
  address: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4"
      onClick={onCancel}
    >
      <div
        className="bg-[#161616] border border-line w-[min(360px,100%)] p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm font-mono text-ink">
            Set <span className="text-accent">{shortAddress(address)}</span> as your primary profile address?
          </p>
          <p className="text-[10px] font-mono text-faint">
            This changes which Farcaster-verified wallet represents you on Kismet — useful if your current address is compromised.
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-mono text-muted hover:text-ink border border-line hover:border-muted transition-colors"
          >
            cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs font-mono text-ink border border-accent bg-accent/10 hover:bg-accent/20 transition-colors"
          >
            confirm
          </button>
        </div>
      </div>
    </div>
  )
}
