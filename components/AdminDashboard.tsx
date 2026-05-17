'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

/**
 * Admin-only dashboard. Hosts moderation utilities that bypass the
 * per-user permission gates the rest of the app enforces — currently
 * just the Hide content tool. New admin utilities should land here too
 * rather than being scattered across one-off pages.
 *
 * Auth model: we hit /api/admin/me with the connected wallet to check
 * the IS_ADMIN bit. That endpoint reads ADMIN_ADDRESS server-side, so
 * we don't duplicate the comparison client-side. Every mutating call
 * runs through AdminContext.withSession so a SIWE login + HttpOnly cookie
 * carries auth — a malicious client that bypasses the visibility gate
 * still can't write.
 */
export function AdminDashboard() {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { withSession } = useAdmin()

  const [adminCheck, setAdminCheck] = useState<{ checked: boolean; isAdmin: boolean }>({
    checked: false,
    isAdmin: false,
  })

  useEffect(() => {
    if (!address) {
      setAdminCheck({ checked: false, isAdmin: false })
      return
    }
    let cancelled = false
    fetch(`/api/admin/me?address=${address}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setAdminCheck({ checked: true, isAdmin: !!d.isAdmin })
      })
      .catch(() => {
        if (!cancelled) setAdminCheck({ checked: true, isAdmin: false })
      })
    return () => {
      cancelled = true
    }
  }, [address])

  if (!isConnected) {
    return (
      <div className="text-center flex flex-col gap-4 items-center py-16">
        <h1 className="text-ink font-mono text-lg">Admin</h1>
        <p className="text-dim font-mono text-xs max-w-md">
          Connect with the admin wallet to access admin utilities.
        </p>
        <button
          onClick={() => openConnectModal?.()}
          className="text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent"
        >
          connect wallet
        </button>
      </div>
    )
  }

  if (!adminCheck.checked) {
    return (
      <div className="text-center py-16">
        <p className="text-xs font-mono text-muted">checking admin status…</p>
      </div>
    )
  }

  if (!adminCheck.isAdmin) {
    return (
      <div className="flex flex-col gap-4 items-center text-center py-16">
        <ShieldAlert size={20} className="text-accent" />
        <h1 className="text-ink font-mono text-lg">Not authorized</h1>
        <p className="text-dim font-mono text-xs max-w-md">
          The connected wallet is not the admin. Switch to the admin wallet and refresh.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {address && (
        <Link
          href={`/profile/${address}`}
          className="text-[10px] font-mono text-muted hover:text-dim transition-colors flex items-center gap-1.5 w-fit uppercase tracking-wider"
        >
          <ArrowLeft size={11} />
          back to profile
        </Link>
      )}

      <div>
        <h1 className="text-ink font-mono text-lg mb-2">Admin</h1>
        <p className="text-dim font-mono text-xs leading-relaxed">
          Admin-only utilities. The first action this session will prompt
          for a wallet signature.
        </p>
      </div>

      <HideContentCard withSession={withSession} />
    </div>
  )
}

type ParsedTarget =
  | { type: 'moment'; address: string; tokenId: string }
  | { type: 'collection'; address: string }

// Match the moment/collection segment in either a full URL or a bare path —
// the leading `/` anchor handles both forms, so we don't need to URL-parse.
// Anything after the address/tokenId (query strings, fragments) is ignored.
function parseTarget(input: string): ParsedTarget | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const moment = trimmed.match(/\/moment\/(0x[a-fA-F0-9]{40})\/(\d+)/)
  if (moment) return { type: 'moment', address: moment[1], tokenId: moment[2] }
  const collection = trimmed.match(/\/collection\/(0x[a-fA-F0-9]{40})/)
  if (collection) return { type: 'collection', address: collection[1] }
  return null
}

function HideContentCard({
  withSession,
}: {
  withSession: <T>(fn: () => Promise<T>) => Promise<T | null>
}) {
  const [link, setLink] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [currentlyHidden, setCurrentlyHidden] = useState<boolean | null>(null)

  const target = parseTarget(link)
  // Effect deps need stable scalars, not a fresh object every render.
  const targetType = target?.type ?? null
  const targetAddress = target?.address ?? null
  const targetTokenId = target?.type === 'moment' ? target.tokenId : null

  // Re-fetch current visibility on every parsed target so the toggle
  // label reflects actual server state (and we don't issue redundant
  // hide/unhide writes).
  useEffect(() => {
    if (!targetType || !targetAddress) {
      setCurrentlyHidden(null)
      return
    }
    let cancelled = false
    const url =
      targetType === 'moment'
        ? `/api/moment/hide?collectionAddress=${targetAddress}&tokenId=${targetTokenId}`
        : `/api/collection/hide?address=${targetAddress}`
    fetch(url)
      .then((r) => r.json() as Promise<{ hidden?: boolean }>)
      .then((d) => {
        if (!cancelled) setCurrentlyHidden(typeof d.hidden === 'boolean' ? d.hidden : null)
      })
      .catch(() => {
        if (!cancelled) setCurrentlyHidden(null)
      })
    return () => {
      cancelled = true
    }
  }, [targetType, targetAddress, targetTokenId])

  async function submit() {
    if (!target || currentlyHidden === null) return
    const next = !currentlyHidden
    setSubmitting(true)
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/hide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: target.type,
            address: target.address,
            ...(target.type === 'moment' ? { tokenId: target.tokenId } : {}),
            hidden: next,
          }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Request failed')
        return true
      })
      if (!ok) return // user cancelled signing
      setCurrentlyHidden(next)
      toast.success(
        next
          ? `${target.type === 'moment' ? 'Moment' : 'Collection'} hidden`
          : `${target.type === 'moment' ? 'Moment' : 'Collection'} restored`,
        { id: 'admin-hide' },
      )
    } catch (err) {
      toastError(next ? 'Hide' : 'Unhide', err, { id: 'admin-hide' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="border border-line bg-[#161616] p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-ink font-mono text-sm">Hide content</h2>
        <p className="text-[11px] font-mono text-dim mt-1 leading-relaxed">
          Paste a moment or collection link to toggle its visibility on
          public feeds. Bypasses the creator/on-chain admin gate that the
          user-facing hide actions enforce. Hiding a collection removes it
          from the collections feed and 404s the collection page; moments
          inside stay reachable by direct link unless hidden individually.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono text-dim uppercase tracking-wider">
          moment or collection link
        </label>
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://kismet.art/moment/0x…/1"
          className="bg-[#0a0a0a] border border-line focus:border-muted outline-none px-2 py-1.5 text-xs font-mono text-ink placeholder:text-[#444]"
        />
      </div>

      {link.trim() && !target && (
        <p className="text-[10px] font-mono text-[#c87474]">
          Could not parse a moment or collection from that link.
        </p>
      )}

      {target && (
        <div className="border border-line bg-[#0a0a0a] p-2 text-[10px] font-mono text-dim flex flex-col gap-1">
          <div>
            <span className="text-muted uppercase tracking-wider mr-2">type</span>
            {target.type}
          </div>
          <div className="break-all">
            <span className="text-muted uppercase tracking-wider mr-2">address</span>
            {target.address}
          </div>
          {target.type === 'moment' && (
            <div>
              <span className="text-muted uppercase tracking-wider mr-2">token</span>
              {target.tokenId}
            </div>
          )}
          <div>
            <span className="text-muted uppercase tracking-wider mr-2">status</span>
            {currentlyHidden === null ? 'checking…' : currentlyHidden ? 'hidden' : 'visible'}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={submit}
        disabled={submitting || !target || currentlyHidden === null}
        className="text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {submitting
          ? 'signing…'
          : currentlyHidden
            ? 'sign & unhide'
            : 'sign & hide'}
      </button>
    </section>
  )
}


