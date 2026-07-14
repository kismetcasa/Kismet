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

export default function GateAdminPage() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, withSession } = useAdmin()

  const [enabled, setEnabled] = useState(false)
  const [passCollection, setPassCollection] = useState('')
  const [paused, setPaused] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    void (async () => {
      // GET goes through withSession (same path as POST below) so the
      // HttpOnly cookie is attached on first load. Plain fetch() here
      // would 401 against the admin-gated route — UI would silently
      // keep the useState defaults, and a subsequent Save would
      // overwrite real config with those defaults. `loaded` gates the
      // form so even a cancelled SIWE prompt can't lead to a defaults
      // overwrite via a later re-prompt during Save.
      const cfg = await withSession(async () => {
        const res = await fetch('/api/admin/gate')
        if (!res.ok) return null
        return (await res.json()) as GateConfig
      })
      if (cancelled || !cfg) return
      setEnabled(!!cfg.enabled)
      setPassCollection(cfg.passCollection ?? '')
      setPaused(!!cfg.paused)
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [isAdmin, withSession])

  async function handleSave() {
    if (passCollection && !isAddress(passCollection)) {
      toast.error('Invalid pass collection address')
      return
    }
    if (enabled && !passCollection) {
      toast.error('Set the pass collection before enabling the gate')
      return
    }

    setSaving(true)
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/gate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled,
            // Always send the field — empty string explicitly clears
            // server-side. Sending undefined would PRESERVE the existing
            // value (a behavior reserved for programmatic API callers).
            passCollection,
            paused,
          }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Save failed')
        return true
      })
      if (!ok) return
      toast.success('Gate config saved')
    } catch (err) {
      toastError('Save', err)
    } finally {
      setSaving(false)
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 flex flex-col items-center gap-4 text-center">
        <h1 className="text-ink font-mono text-lg">Token gate</h1>
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
        <h1 className="text-ink font-mono text-lg mb-2">Token gate</h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          When enabled, mint requires holding any tokenId from the pass
          collection (acquired through mint, airdrop, or platform sale).
          Admin and pass-collection mints are always exempt — admin can
          issue new pass tokens at any time without paradox.
        </p>
      </div>

      {!loaded ? (
        <p className="text-xs font-mono text-muted">loading config…</p>
      ) : (
        <>
          <div className="flex items-center justify-between border border-line px-3 py-3">
            <span className="text-xs font-mono text-dim uppercase tracking-wider">gate enabled</span>
            <button type="button" onClick={() => setEnabled((v) => !v)} aria-pressed={enabled} className="flex-shrink-0">
              <div className={`relative w-8 h-4 rounded-full transition-colors ${enabled ? 'bg-accent' : 'bg-line border border-[#3a3a3a]'}`}>
                <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0'}`} />
              </div>
            </button>
          </div>

          <div>
            <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">Pass collection</label>
            <input
              type="text"
              value={passCollection}
              onChange={(e) => setPassCollection(e.target.value.trim())}
              placeholder="0x… ERC1155 contract"
              className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-[#444] focus:outline-none focus:border-muted"
            />
            <p className="text-[10px] font-mono text-muted mt-1.5">
              dedicate this collection to passes. every tokenId minted into it grants gate access.
            </p>
          </div>

          <div className="flex items-center justify-between border border-line px-3 py-3">
            <div className="flex flex-col">
              <span className="text-xs font-mono text-dim uppercase tracking-wider">platform paused</span>
              <span className="text-[10px] font-mono text-muted mt-0.5">
                emergency kill switch — blocks new mints &amp; collection creation. admin still bypasses.
              </span>
            </div>
            <button type="button" onClick={() => setPaused((v) => !v)} aria-pressed={paused} className="flex-shrink-0">
              <div className={`relative w-8 h-4 rounded-full transition-colors ${paused ? 'bg-red-500' : 'bg-line border border-[#3a3a3a]'}`}>
                <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${paused ? 'translate-x-4' : 'translate-x-0'}`} />
              </div>
            </button>
          </div>

          <button onClick={handleSave} disabled={saving} className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50 disabled:cursor-not-allowed">
            {saving ? 'saving…' : 'sign & save'}
          </button>
        </>
      )}
    </div>
  )
}
