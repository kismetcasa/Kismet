'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { formatPrice, shortAddress } from '@/lib/inprocess'
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
      <TokenGateCard />
      <AirdropQuotaCard />
    </div>
  )
}

/** Single-link card for the airdrop quota sub-page. Lives apart from the
 *  token-gate card because the quota controls cohort throughput, not
 *  access — same admin surface, different operational lever. */
function AirdropQuotaCard() {
  return (
    <section className="border border-line bg-[#161616] p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-ink font-mono text-sm">Airdrop quota</h2>
        <p className="text-[11px] font-mono text-dim mt-1 leading-relaxed">
          Per-artist daily cadence and weekly cap on airdrop mints. Defaults
          to 1/day and 5/week; admin is always exempt.
        </p>
      </div>
      <Link
        href="/admin/airdrop-quota"
        className="block border border-line bg-[#0a0a0a] px-3 py-2.5 hover:border-muted transition-colors"
      >
        <div className="text-xs font-mono text-ink uppercase tracking-wider">Quota config</div>
        <div className="text-[10px] font-mono text-dim mt-1">edit the per-day and per-week limits.</div>
      </Link>
    </section>
  )
}

/** Token-gate management surface. Sub-pages handle the actual UI so the
 *  dashboard stays scannable; each tool has its own state and deep-link.
 *  Listed in workflow order: configure gate, grant validity (the most
 *  frequent post-airdrop action), moderate addresses. */
function TokenGateCard() {
  const links: { href: string; title: string; desc: string }[] = [
    {
      href: '/admin/gate',
      title: 'Gate config',
      desc: 'enable/disable the pass requirement; set the pass collection; emergency pause.',
    },
    {
      href: '/admin/pass',
      title: 'Pass validity',
      desc: 'manually grant or revoke pass validity for an address (used after airdrops).',
    },
    {
      href: '/admin/blacklist',
      title: 'Moderation',
      desc:
        'four address lists: action blacklist (block mint/list/airdrop), pass blacklist (deny validity), hidden users (strip content from public feeds), hidden profiles (404 the profile page).',
    },
  ]

  return (
    <section className="border border-line bg-[#161616] p-4 flex flex-col gap-3">
      <div>
        <h2 className="text-ink font-mono text-sm">Token gate</h2>
        <p className="text-[11px] font-mono text-dim mt-1 leading-relaxed">
          Configure the Pass-collection gate, override validity for specific
          addresses, and moderate users (action blacklist, pass blacklist,
          hidden users). Each sub-page handles its own signing prompt.
        </p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {links.map((l) => (
          <li key={l.href}>
            <Link
              href={l.href}
              className="block border border-line bg-[#0a0a0a] px-3 py-2.5 hover:border-muted transition-colors"
            >
              <div className="text-xs font-mono text-ink uppercase tracking-wider">{l.title}</div>
              <div className="text-[10px] font-mono text-dim mt-1">{l.desc}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

type ParsedTarget =
  | { type: 'moment'; address: string; tokenId: string }
  | { type: 'collection'; address: string }
  | { type: 'profile'; address: string }

// Match the moment/collection/profile segment in either a full URL or a bare
// path — the leading `/` anchor handles both forms, so we don't need to
// URL-parse. Anything after the address/tokenId (query strings, fragments)
// is ignored.
function parseTarget(input: string): ParsedTarget | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const moment = trimmed.match(/\/moment\/(0x[a-fA-F0-9]{40})\/(\d+)/)
  if (moment) return { type: 'moment', address: moment[1], tokenId: moment[2] }
  const collection = trimmed.match(/\/collection\/(0x[a-fA-F0-9]{40})/)
  if (collection) return { type: 'collection', address: collection[1] }
  const profile = trimmed.match(/\/profile\/(0x[a-fA-F0-9]{40})/)
  if (profile) return { type: 'profile', address: profile[1] }
  return null
}

// Row shape returned by GET /api/admin/hide for a moment's marketplace
// listings — includes already-hidden ones the public feed filters out.
type AdminListingRow = {
  id: string
  seller: string
  price: string
  currency: 'eth' | 'usdc'
  name?: string
  expiresAt: number
  hidden: boolean
}

function HideContentCard({
  withSession,
}: {
  withSession: <T>(fn: () => Promise<T>) => Promise<T | null>
}) {
  const [link, setLink] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [currentlyHidden, setCurrentlyHidden] = useState<boolean | null>(null)
  // null = not applicable (no moment parsed). 'error' covers both fetch
  // failures and a declined SIWE prompt — the GET is admin-gated.
  const [listings, setListings] = useState<AdminListingRow[] | 'loading' | 'error' | null>(null)
  const [listingBusy, setListingBusy] = useState<string | null>(null)

  const target = parseTarget(link)
  // Effect deps need stable scalars, not a fresh object every render.
  const targetType = target?.type ?? null
  const targetAddress = target?.address ?? null
  const targetTokenId = target?.type === 'moment' ? target.tokenId : null

  // Re-fetch current visibility on every parsed target so the toggle
  // label reflects actual server state (and we don't issue redundant
  // hide/unhide writes). Moment/collection status comes from the public
  // hide GETs; profile status has no public endpoint (hidden state
  // shouldn't be probeable), so it reads the admin-gated list via
  // withSession like the moderation page does.
  useEffect(() => {
    if (!targetType || !targetAddress) {
      setCurrentlyHidden(null)
      return
    }
    let cancelled = false
    if (targetType === 'profile') {
      withSession(async () => {
        const res = await fetch('/api/admin/hidden-profiles')
        if (!res.ok) return null
        const d = (await res.json()) as { addresses?: string[] }
        return Array.isArray(d.addresses) ? d.addresses : null
      })
        .then((addrs) => {
          if (cancelled) return
          setCurrentlyHidden(addrs ? addrs.includes(targetAddress.toLowerCase()) : null)
        })
        .catch(() => {
          if (!cancelled) setCurrentlyHidden(null)
        })
      return () => {
        cancelled = true
      }
    }
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
  }, [targetType, targetAddress, targetTokenId, withSession])

  // Marketplace listings for a parsed moment, via the admin-gated GET on
  // /api/admin/hide (withSession — may prompt the one-per-session SIWE
  // signature, same as the moderation page's list loads). The public
  // /api/listings feed filters hidden listings out, so this is the only
  // surface where the admin can see one to unhide it.
  useEffect(() => {
    if (targetType !== 'moment' || !targetAddress || !targetTokenId) {
      setListings(null)
      return
    }
    let cancelled = false
    setListings('loading')
    withSession(async () => {
      const res = await fetch(`/api/admin/hide?address=${targetAddress}&tokenId=${targetTokenId}`)
      if (!res.ok) return null
      const d = (await res.json()) as { listings?: AdminListingRow[] }
      return Array.isArray(d.listings) ? d.listings : null
    })
      .then((rows) => {
        if (!cancelled) setListings(rows ?? 'error')
      })
      .catch(() => {
        if (!cancelled) setListings('error')
      })
    return () => {
      cancelled = true
    }
  }, [targetType, targetAddress, targetTokenId, withSession])

  async function toggleListing(row: AdminListingRow) {
    if (!target || target.type !== 'moment') return
    const next = !row.hidden
    setListingBusy(row.id)
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/hide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'listing',
            address: target.address,
            tokenId: target.tokenId,
            seller: row.seller,
            hidden: next,
          }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Request failed')
        return true
      })
      if (!ok) return // user cancelled signing
      setListings((prev) =>
        Array.isArray(prev) ? prev.map((l) => (l.id === row.id ? { ...l, hidden: next } : l)) : prev,
      )
      toast.success(next ? 'Listing hidden' : 'Listing restored', { id: 'admin-hide-listing' })
    } catch (err) {
      toastError(next ? 'Hide listing' : 'Unhide listing', err, { id: 'admin-hide-listing' })
    } finally {
      setListingBusy(null)
    }
  }

  async function submit() {
    if (!target || currentlyHidden === null) return
    const next = !currentlyHidden
    setSubmitting(true)
    try {
      const ok = await withSession(async () => {
        // Profiles live on their own admin list (POST hides, DELETE
        // restores) — same list the moderation page manages by raw
        // address; moments and collections share /api/admin/hide.
        const res =
          target.type === 'profile'
            ? await fetch('/api/admin/hidden-profiles', {
                method: next ? 'POST' : 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: target.address }),
              })
            : await fetch('/api/admin/hide', {
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
      const label =
        target.type === 'moment' ? 'Moment' : target.type === 'collection' ? 'Collection' : 'Profile'
      toast.success(next ? `${label} hidden` : `${label} restored`, { id: 'admin-hide' })
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
          Paste a moment, collection, or profile link to toggle its
          visibility. Bypasses the creator/on-chain admin gate that the
          user-facing hide actions enforce. Hiding a collection removes it
          from the collections feed and 404s the collection page; moments
          inside stay reachable by direct link unless hidden individually.
          Hiding a moment (or collection) also pulls its marketplace
          listings; for a listing that should go while the moment stays
          up, use the per-listing toggles below. Hiding a profile 404s the
          profile page for everyone but its owner — content visibility is
          unaffected (use Moderation → Hidden users for that).
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono text-dim uppercase tracking-wider">
          moment, collection, or profile link
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
          Could not parse a moment, collection, or profile from that link.
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

      {target?.type === 'moment' && listings !== null && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono text-dim uppercase tracking-wider">
            marketplace listings
          </span>
          {listings === 'loading' ? (
            <p className="text-[10px] font-mono text-muted">loading listings…</p>
          ) : listings === 'error' ? (
            <p className="text-[10px] font-mono text-muted">
              listings unavailable — sign in with the admin wallet and re-paste the link.
            </p>
          ) : listings.length === 0 ? (
            <p className="text-[10px] font-mono text-muted">no active listings for this moment.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {listings.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center justify-between gap-2 border border-line bg-[#0a0a0a] px-2 py-1.5"
                >
                  <span className="text-[10px] font-mono text-ink truncate">
                    {shortAddress(l.seller)} · {formatPrice(l.price, l.currency)} ·{' '}
                    {l.hidden ? 'hidden' : 'visible'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void toggleListing(l)}
                    disabled={listingBusy === l.id}
                    className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-ink disabled:opacity-50"
                  >
                    {listingBusy === l.id ? 'signing…' : l.hidden ? 'unhide' : 'hide'}
                  </button>
                </li>
              ))}
            </ul>
          )}
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


