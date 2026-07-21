'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

interface GateConfig {
  enabled: boolean
  passCollection: string | null
  paused: boolean
}

export default function PassAdminPage() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, withSession } = useAdmin()

  const [config, setConfig] = useState<GateConfig | null>(null)
  const [lookupAddress, setLookupAddress] = useState('')
  const [currentValue, setCurrentValue] = useState<number | null>(null)
  const [newValue, setNewValue] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    void (async () => {
      // GET goes through withSession (same path as the pass-validity
      // mutations below) so the HttpOnly cookie is attached on first
      // load. Plain fetch() would 401 against the admin-gated route
      // and the readonly gate-config block would silently stay hidden.
      const cfg = await withSession(async () => {
        const res = await fetch('/api/admin/gate')
        if (!res.ok) return null
        return (await res.json()) as GateConfig
      })
      if (cancelled || !cfg) return
      setConfig(cfg)
    })()
    return () => { cancelled = true }
  }, [isAdmin, withSession])

  async function fetchCurrent() {
    if (!lookupAddress || !isAddress(lookupAddress)) {
      setCurrentValue(null)
      return
    }
    const result = await withSession(async () => {
      const params = new URLSearchParams({ address: lookupAddress })
      const res = await fetch(`/api/admin/pass-validity?${params}`)
      if (!res.ok) return null
      const d = (await res.json()) as { validBalance?: number }
      return typeof d.validBalance === 'number' ? d.validBalance : null
    })
    setCurrentValue(result ?? null)
  }

  async function handleSave() {
    if (!isAddress(lookupAddress)) {
      toast.error('Invalid address')
      return
    }
    const value = parseInt(newValue, 10)
    if (!Number.isInteger(value) || value < 0) {
      toast.error('Value must be a non-negative integer')
      return
    }

    setBusy(true)
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/pass-validity', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: lookupAddress, value }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Save failed')
        return true
      })
      if (!ok) return
      toast.success('Pass validity updated')
      setCurrentValue(value)
      setNewValue('')
    } catch (err) {
      toastError('Save', err)
    } finally {
      setBusy(false)
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 flex flex-col items-center gap-4 text-center">
        <h1 className="text-ink font-mono text-lg">Pass admin</h1>
        <p className="text-dim font-mono text-xs">connect with the admin wallet to continue</p>
        <button onClick={() => openConnectModal?.()} className="px-4 py-2 text-xs font-mono uppercase tracking-widest btn-accent">
          connect wallet
        </button>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 flex flex-col gap-4 items-center text-center">
        <ShieldAlert size={20} className="text-accent" />
        <h1 className="text-ink font-mono text-lg">Not authorized</h1>
        <p className="text-dim font-mono text-xs">Switch to the admin wallet and refresh.</p>
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-12 flex flex-col gap-6">
      {address && (
        <Link href="/admin" className="text-[10px] font-mono text-muted hover:text-dim flex items-center gap-1.5 w-fit uppercase tracking-wider">
          <ArrowLeft size={11} />
          back to admin
        </Link>
      )}

      <div>
        <h1 className="text-ink font-mono text-lg mb-2">Pass admin</h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          Manually grant or revoke pass validity for an address. Grants bypass
          live on-chain reconciliation, so you can pre-authorize someone
          before they actually hold a pass. Revoking (set to 0) blocks the
          address even if they still hold the pass on-chain.
        </p>
      </div>

      {config && (
        <div className="border border-line px-3 py-3 text-xs font-mono text-dim flex flex-col gap-1">
          <div>gate enabled: <span className="text-ink">{config.enabled ? 'yes' : 'no'}</span></div>
          <div>pass collection: <span className="text-ink">{config.passCollection ?? 'unset'}</span></div>
          <div>paused: <span className="text-ink">{config.paused ? 'yes' : 'no'}</span></div>
        </div>
      )}

      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">Address</label>
        <input
          type="text"
          value={lookupAddress}
          onChange={(e) => {
            setLookupAddress(e.target.value.trim())
            setCurrentValue(null)
          }}
          onBlur={fetchCurrent}
          placeholder="0x…"
          className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
        {currentValue !== null && (
          <p className="text-[10px] font-mono text-dim mt-1.5">
            current valid balance: <span className="text-ink">{currentValue}</span>
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">New value</label>
        <input
          type="number"
          min="0"
          step="1"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="0 to revoke, ≥1 to grant"
          className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
        />
      </div>

      <button onClick={handleSave} disabled={busy || !config?.passCollection} className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
        {busy ? 'saving…' : 'sign & set valid balance'}
      </button>

      {!config?.passCollection && (
        <p className="text-[10px] font-mono text-muted text-center">set a pass collection in /admin/gate first</p>
      )}
    </div>
  )
}
