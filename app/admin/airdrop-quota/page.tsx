'use client'

import Link from 'next/link'
import { useState, useEffect } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

interface Limits {
  day: number
  week: number
}

export default function AirdropQuotaAdminPage() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin, withSession } = useAdmin()

  const [day, setDay] = useState('')
  const [week, setWeek] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    void (async () => {
      // Same fail-closed pattern as /admin/gate: GET must use the same
      // auth path as POST, and the form must not be operable until the
      // real limits arrive — otherwise an admin who cancels SIWE then
      // signs the Save re-prompt would post the JS defaults over the
      // real config.
      const limits = await withSession(async () => {
        const res = await fetch('/api/admin/airdrop-quota')
        if (!res.ok) return null
        return (await res.json()) as Limits
      })
      if (cancelled || !limits) return
      setDay(String(limits.day ?? 1))
      setWeek(String(limits.week ?? 5))
      setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [isAdmin, withSession])

  async function handleSave() {
    const dayNum = parseInt(day, 10)
    const weekNum = parseInt(week, 10)
    if (!Number.isInteger(dayNum) || dayNum < 0) {
      toast.error('Day limit must be a non-negative integer')
      return
    }
    if (!Number.isInteger(weekNum) || weekNum < 0) {
      toast.error('Week limit must be a non-negative integer')
      return
    }
    if (dayNum > weekNum) {
      toast.error('Day limit cannot exceed week limit')
      return
    }

    setSaving(true)
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/airdrop-quota', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ day: dayNum, week: weekNum }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Save failed')
        return true
      })
      if (!ok) return
      toast.success('Airdrop quota saved')
    } catch (err) {
      toastError('Save', err)
    } finally {
      setSaving(false)
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 flex flex-col items-center gap-4 text-center">
        <h1 className="text-ink font-mono text-lg">Airdrop quota</h1>
        <p className="text-dim font-mono text-xs">connect with the admin wallet to continue</p>
        <button
          onClick={() => openConnectModal?.()}
          className="px-4 py-2 text-xs font-mono uppercase tracking-widest btn-accent"
        >
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
        <h1 className="text-ink font-mono text-lg mb-2">Airdrop quota</h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          Daily cadence and weekly cap for every airdropper. Each recipient in
          a multi-recipient airdrop counts as one mint against both buckets
          (a 3-recipient airdrop spends 3 of the day cap). Admin is exempt.
          Buckets reset at UTC midnight (day) and Monday 00:00 UTC (week).
          Setting either to 0 hard-blocks all non-admin airdrops on that window.
        </p>
      </div>

      {!loaded ? (
        <p className="text-xs font-mono text-muted">loading limits…</p>
      ) : (
        <>
          <div>
            <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
              Per day (cadence)
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              placeholder="1"
              className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-[#444] focus:outline-none focus:border-muted"
            />
            <p className="text-[10px] font-mono text-muted mt-1.5">
              max airdrop mints per artist per UTC calendar day.
            </p>
          </div>

          <div>
            <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
              Per week (cap)
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
              placeholder="5"
              className="w-full bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-[#444] focus:outline-none focus:border-muted"
            />
            <p className="text-[10px] font-mono text-muted mt-1.5">
              max airdrop mints per artist per ISO week (Monday-start, UTC).
            </p>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'saving…' : 'sign & save'}
          </button>
        </>
      )}
    </div>
  )
}
