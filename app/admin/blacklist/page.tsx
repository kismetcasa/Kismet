'use client'

import Link from 'next/link'
import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

/**
 * Unified moderation surface with four independent lists:
 *
 *   1. Action blacklist  — blocks the address from minting, writing,
 *                          listing on secondary, and recording airdrops.
 *                          Their existing content stays visible and
 *                          collectable.
 *   2. Pass blacklist    — denies Pass validity even when the address
 *                          holds a Pass on-chain. The webhook will not
 *                          credit transfers to them.
 *   3. Hidden users      — strips every public-feed entry authored by
 *                          the address. The user themselves still sees
 *                          their own content on their own profile.
 *   4. Hidden profiles   — 404s the profile page + identity surfaces
 *                          (profile API, search, share card) for everyone
 *                          but the owner. Content visibility unaffected.
 *
 * Each list is independent: an address can be on any subset. Combine
 * #1 + #3 for a full ban (can't create, content gone from feeds);
 * #3 + #4 to make a user fully invisible (content AND identity);
 * #1 + #2 for a Pass-specific revocation that also prevents creator
 * action; #2 alone for a pure cohort-quality revocation.
 *
 * There is intentionally no profile DELETE: profiles are wallet-keyed
 * and rebuilt by the owner's next signed update, so deletion would be
 * destructive yet trivially reversible — hiding is the enforceable lever.
 *
 * Path stayed at `/admin/blacklist` so existing dashboard links and
 * bookmarks resolve; the in-page title is "Moderation".
 */

type ListConfig = {
  id: 'actions' | 'pass' | 'hidden' | 'profiles'
  title: string
  desc: string
  endpoint: string
  addLabel: string
  removeLabel: string
}

const LISTS: ListConfig[] = [
  {
    id: 'actions',
    title: 'Action blacklist',
    desc:
      'Blocks the address from minting, writing, listing on secondary, and airdropping. Their existing content stays visible and collectable; only new creator actions are denied.',
    endpoint: '/api/admin/blacklist',
    addLabel: 'block',
    removeLabel: 'unblock',
  },
  {
    id: 'pass',
    title: 'Pass blacklist',
    desc:
      'Denies Pass validity even when the address holds a Pass on-chain. Transfers to a Pass-blacklisted address do not credit them with validity. Useful for revoking creator access after acquisition.',
    endpoint: '/api/admin/pass-blacklist',
    addLabel: 'block',
    removeLabel: 'unblock',
  },
  {
    id: 'hidden',
    title: 'Hidden users',
    desc:
      "Strips every public-feed entry authored by this address — artworks, collections, listings, featured rows, search. The user's own profile still surfaces their content to themselves. Distinct from per-content hiding (under Hide content on the admin dashboard).",
    endpoint: '/api/admin/hidden-users',
    addLabel: 'hide',
    removeLabel: 'unhide',
  },
  {
    id: 'profiles',
    title: 'Hidden profiles',
    desc:
      'Hides the profile itself: the profile page 404s for everyone but the owner, and the identity drops out of the profile API, search, and share cards. Sibling-aware — hiding any of a Farcaster user’s verified wallets hides them all. Content visibility is unaffected; combine with Hidden users for full invisibility.',
    endpoint: '/api/admin/hidden-profiles',
    addLabel: 'hide',
    removeLabel: 'unhide',
  },
]

export default function ModerationPage() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isAdmin } = useAdmin()

  if (!isConnected) {
    return (
      <div className="max-w-lg mx-auto px-4 py-12 flex flex-col items-center gap-4 text-center">
        <h1 className="text-ink font-mono text-lg">Moderation</h1>
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
        <h1 className="text-ink font-mono text-lg mb-2">Moderation</h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          Four independent address lists. An address can appear on any
          subset; combine for fuller bans. Admin is exempt from all four.
          The first action this session will prompt for a wallet signature.
        </p>
      </div>

      {LISTS.map((cfg) => (
        <ModerationListSection key={cfg.id} config={cfg} />
      ))}
    </div>
  )
}

function ModerationListSection({ config }: { config: ListConfig }) {
  const { withSession, isAdmin } = useAdmin()

  const [addresses, setAddresses] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const result = await withSession(async () => {
      const res = await fetch(config.endpoint)
      if (!res.ok) return null
      const d = (await res.json()) as { addresses?: string[] }
      return Array.isArray(d.addresses) ? d.addresses : []
    })
    // null = withSession declined / cancelled — keep last-known list,
    // don't blank to empty (would hide existing entries from the admin
    // who just opted not to sign right now).
    if (result === null) return
    setAddresses(result)
    setLoaded(true)
  }, [withSession, config.endpoint])

  useEffect(() => {
    if (isAdmin) void refresh()
  }, [isAdmin, refresh])

  async function handleAdd() {
    const target = input.trim()
    if (!isAddress(target)) {
      toast.error('Invalid address')
      return
    }
    setBusy(true)
    try {
      const ok = await withSession(async () => {
        const res = await fetch(config.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: target }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Add failed')
        return true
      })
      if (!ok) return
      toast.success(`${config.addLabel}ed`)
      setInput('')
      await refresh()
    } catch (err) {
      toastError(config.addLabel, err)
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(addr: string) {
    try {
      const ok = await withSession(async () => {
        const res = await fetch(config.endpoint, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Remove failed')
        return true
      })
      if (!ok) return
      toast.success(`${config.removeLabel}d`)
      await refresh()
    } catch (err) {
      toastError(config.removeLabel, err)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-ink font-mono text-sm">{config.title}</h2>
        <p className="text-[11px] font-mono text-dim mt-1 leading-relaxed">{config.desc}</p>
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            void handleAdd()
          }}
          placeholder="0x…"
          className="flex-1 bg-[#0a0a0a] border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-[#444] focus:outline-none focus:border-muted"
        />
        <button
          onClick={() => void handleAdd()}
          disabled={busy}
          className="px-4 text-xs font-mono uppercase tracking-widest btn-accent disabled:opacity-50"
        >
          {config.addLabel}
        </button>
      </div>

      <div>
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-muted mb-2">
          listed ({addresses.length})
        </h3>
        {!loaded ? (
          <p className="text-xs font-mono text-muted">loading…</p>
        ) : addresses.length === 0 ? (
          <p className="text-xs font-mono text-muted">none</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {addresses.map((addr) => (
              <li
                key={addr}
                className="flex items-center justify-between border border-line px-3 py-2"
              >
                <span className="text-xs font-mono text-ink truncate">{addr}</span>
                <button
                  onClick={() => void handleRemove(addr)}
                  className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink"
                >
                  {config.removeLabel}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
