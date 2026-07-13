'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useAdmin } from '@/contexts/AdminContext'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'
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

      <HideContentCard />
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
// Derived from the stored Listing shape so the two can't drift.
type AdminListingRow = Pick<Listing, 'id' | 'seller' | 'price' | 'currency'> & {
  hidden: boolean
}

// Listings-panel state machine. `loaded` pins the (address, tokenId) the
// rows were fetched FOR, and toggles POST against that pin — not the
// live-parsed link — so a click landing in the one-paint window after the
// admin edits the URL can't write a mixed-provenance hide key.
type ListingsPanel =
  | { kind: 'idle' }
  | { kind: 'auth' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'loaded'
      forAddress: string
      forTokenId: string
      momentHidden: boolean
      collectionHidden: boolean
      rows: AdminListingRow[]
    }

function HideContentCard() {
  const { withSession, hasSession, startSession } = useAdmin()

  const [link, setLink] = useState('')
  // Debounced copy drives parsing + fetches: the tokenId regex matches every
  // digit of a partial edit, so undebounced effects would fire the admin GET
  // (a 500-id market scan) once per keystroke.
  const [debouncedLink, setDebouncedLink] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedLink(link), 300)
    return () => clearTimeout(t)
  }, [link])

  const [submitting, setSubmitting] = useState(false)
  const [currentlyHidden, setCurrentlyHidden] = useState<boolean | null>(null)
  const [statusError, setStatusError] = useState(false)
  // The hidden-profiles entry that actually matches the pasted identity —
  // may be a SIBLING wallet of the pasted address (the gate is sibling-
  // aware), so unhide must DELETE this entry, not the pasted address.
  const [matchedAddress, setMatchedAddress] = useState<string | null>(null)
  // Bumped after a successful toggle so the status + listings effects
  // refetch server truth (cascade flags, matched entry) instead of trusting
  // optimistic state.
  const [refresh, setRefresh] = useState(0)
  const [listings, setListings] = useState<ListingsPanel>({ kind: 'idle' })
  const [listingBusy, setListingBusy] = useState<string | null>(null)
  // Erase is a hard, irreversible delete — two-tap arm/confirm guards it.
  // eraseFcFid, set after erasing a Farcaster identity, drives the "also
  // hide" offer (an FC name re-resolves; erase can't remove it).
  const [erasing, setErasing] = useState(false)
  const [eraseArmed, setEraseArmed] = useState(false)
  const [eraseFcFid, setEraseFcFid] = useState<number | null>(null)
  const eraseArmRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (eraseArmRef.current) clearTimeout(eraseArmRef.current)
  }, [])

  const target = parseTarget(debouncedLink)
  // Effect deps need stable scalars, not a fresh object every render.
  const targetType = target?.type ?? null
  const targetAddress = target?.address ?? null
  const targetTokenId = target?.type === 'moment' ? target.tokenId : null

  // Reset the destructive-erase arm + FC-residue offer whenever the target
  // changes, so a "confirm" armed for one profile can't fire on another.
  useEffect(() => {
    setEraseArmed(false)
    setEraseFcFid(null)
  }, [targetType, targetAddress])

  // Re-fetch current visibility on every parsed target so the toggle
  // label reflects actual server state (and we don't issue redundant
  // hide/unhide writes). Moment/collection status comes from the public
  // hide GETs. Profile status has no public endpoint (hidden state
  // shouldn't be probeable) and is sibling-aware server-side — it reads
  // the admin-gated lookup, and ONLY once a session already exists:
  // passive reads must never pop a wallet prompt (the sign-in affordance
  // below covers the no-session case).
  useEffect(() => {
    if (!targetType || !targetAddress) {
      setCurrentlyHidden(null)
      setStatusError(false)
      setMatchedAddress(null)
      return
    }
    let cancelled = false
    setCurrentlyHidden(null)
    setStatusError(false)
    setMatchedAddress(null)
    if (targetType === 'profile') {
      if (!hasSession) return
      fetch(`/api/admin/hidden-profiles?address=${targetAddress}`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{ hidden?: boolean; matchedAddress?: string | null }>)
            : null,
        )
        .then((d) => {
          if (cancelled) return
          if (!d || typeof d.hidden !== 'boolean') {
            setStatusError(true)
            return
          }
          setCurrentlyHidden(d.hidden)
          setMatchedAddress(d.matchedAddress ?? null)
        })
        .catch(() => {
          if (!cancelled) setStatusError(true)
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
        if (cancelled) return
        if (typeof d.hidden === 'boolean') setCurrentlyHidden(d.hidden)
        else setStatusError(true)
      })
      .catch(() => {
        if (!cancelled) setStatusError(true)
      })
    return () => {
      cancelled = true
    }
  }, [targetType, targetAddress, targetTokenId, hasSession, refresh])

  // Marketplace listings for a parsed moment, via the admin-gated GET on
  // /api/admin/hide. The public /api/listings feed filters hidden listings
  // out, so this is the only surface where the admin can see one to unhide
  // it. Gated on hasSession like the profile status; the response also
  // carries the moment/collection cascade flags so the panel can explain
  // why a "visible"-flagged row is still off the market.
  useEffect(() => {
    if (targetType !== 'moment' || !targetAddress || !targetTokenId) {
      setListings({ kind: 'idle' })
      return
    }
    if (!hasSession) {
      setListings({ kind: 'auth' })
      return
    }
    let cancelled = false
    setListings({ kind: 'loading' })
    fetch(`/api/admin/hide?address=${targetAddress}&tokenId=${targetTokenId}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              momentHidden?: boolean
              collectionHidden?: boolean
              listings?: AdminListingRow[]
            }>)
          : null,
      )
      .then((d) => {
        if (cancelled) return
        if (!d || !Array.isArray(d.listings)) {
          setListings({ kind: 'error' })
          return
        }
        setListings({
          kind: 'loaded',
          forAddress: targetAddress,
          forTokenId: targetTokenId,
          momentHidden: !!d.momentHidden,
          collectionHidden: !!d.collectionHidden,
          rows: d.listings,
        })
      })
      .catch(() => {
        if (!cancelled) setListings({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [targetType, targetAddress, targetTokenId, hasSession, refresh])

  async function toggleListing(row: AdminListingRow) {
    if (listings.kind !== 'loaded') return
    const { forAddress, forTokenId, momentHidden, collectionHidden } = listings
    const next = !row.hidden
    setListingBusy(row.id)
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/hide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'listing',
            address: forAddress,
            tokenId: forTokenId,
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
        prev.kind === 'loaded'
          ? { ...prev, rows: prev.rows.map((l) => (l.id === row.id ? { ...l, hidden: next } : l)) }
          : prev,
      )
      // Cascade-aware copy: removing the per-listing flag does NOT restore
      // a listing whose moment or collection is still hidden.
      const stillCascaded = !next && (momentHidden || collectionHidden)
      toast.success(
        next
          ? 'Listing hidden'
          : stillCascaded
            ? 'Listing flag removed — still hidden via the moment/collection hide'
            : 'Listing restored',
        { id: 'admin-hide-listing' },
      )
    } catch (err) {
      toastError(next ? 'Hide listing' : 'Unhide listing', err, { id: 'admin-hide-listing' })
    } finally {
      // Functional clear: only release the flag if this toggle still owns
      // it, so an overlapping toggle on another row keeps its busy state.
      setListingBusy((prev) => (prev === row.id ? null : prev))
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
        // address; moments and collections share /api/admin/hide. Unhide
        // targets the SIBLING entry the status lookup matched, which may
        // differ from the pasted address.
        const res =
          target.type === 'profile'
            ? await fetch('/api/admin/hidden-profiles', {
                method: next ? 'POST' : 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  address: next ? target.address : (matchedAddress ?? target.address),
                }),
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
      // Refetch server truth: the listings panel's cascade flags change
      // when a moment is toggled, and a profile hide's matched entry is
      // now the pasted address (or gone).
      setRefresh((v) => v + 1)
      const label =
        target.type === 'moment' ? 'Moment' : target.type === 'collection' ? 'Collection' : 'Profile'
      toast.success(next ? `${label} hidden` : `${label} restored`, { id: 'admin-hide' })
    } catch (err) {
      toastError(next ? 'Hide' : 'Unhide', err, { id: 'admin-hide' })
    } finally {
      setSubmitting(false)
    }
  }

  function armErase() {
    setEraseArmed(true)
    if (eraseArmRef.current) clearTimeout(eraseArmRef.current)
    // Auto-disarm so a stale "confirm" can't fire a destructive delete later.
    eraseArmRef.current = setTimeout(() => setEraseArmed(false), 4000)
  }

  // Hard, irreversible erase of a profile identity (+ its FID siblings).
  async function eraseProfile() {
    if (!target || target.type !== 'profile') return
    setErasing(true)
    try {
      const erased = await withSession(async () => {
        const res = await fetch('/api/admin/erase-profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: target.address }),
        })
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          erased?: { addresses?: string[]; fid?: number | null }
          fcResolved?: boolean
        }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Request failed')
        return {
          ...(json.erased ?? { addresses: [target.address], fid: null }),
          fcResolved: json.fcResolved !== false,
        }
      })
      if (!erased) return // user cancelled signing
      setEraseArmed(false)
      const n = erased.addresses?.length ?? 1
      // fcResolved === false → the queried wallet IS erased, but Farcaster
      // couldn't be reached to confirm/expand its verified siblings. Warn
      // rather than claim a clean success: the admin re-runs once FC is
      // reachable (idempotent, so it's a safe no-op if there were no siblings).
      if (erased.fcResolved === false) {
        toast.warning(
          `Wallet erased — couldn't confirm Farcaster-linked wallets. Re-run when Farcaster is reachable to catch any siblings.`,
          { id: 'admin-erase', duration: 8000 },
        )
      } else {
        toast.success(`Profile erased (${n} wallet${n === 1 ? '' : 's'})`, { id: 'admin-erase' })
      }
      // The identity is gone — reset the card's status view.
      setCurrentlyHidden(null)
      setMatchedAddress(null)
      setRefresh((v) => v + 1)
      // FC residue: an erased Farcaster identity's name re-resolves from
      // Farcaster (we can't delete their FC account), so offer a one-click
      // hide to suppress it too. Only when we actually resolved a FID — a
      // failed resolution leaves fid null and there's nothing to also-hide.
      setEraseFcFid(erased.fid ?? null)
    } catch (err) {
      toastError('Erase', err, { id: 'admin-erase' })
    } finally {
      setErasing(false)
    }
  }

  // One-click "also hide" for the FC residue after an erase.
  async function hideFcResidue() {
    if (!target || target.type !== 'profile') return
    try {
      const ok = await withSession(async () => {
        const res = await fetch('/api/admin/hidden-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: target.address }),
        })
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || !json.ok) throw new Error(json.error ?? 'Request failed')
        return true
      })
      if (!ok) return
      setEraseFcFid(null)
      setCurrentlyHidden(true)
      toast.success('Farcaster identity hidden', { id: 'admin-erase' })
    } catch (err) {
      toastError('Hide', err, { id: 'admin-erase' })
    }
  }

  const needsSignIn = !!target && !hasSession && target.type === 'profile'

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
          className="bg-[#0a0a0a] border border-line focus:border-muted outline-none px-2 py-1.5 text-xs font-mono text-ink placeholder:text-subtle"
        />
      </div>

      {debouncedLink.trim() && !target && (
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
            {statusError
              ? 'unavailable — sign in with the admin wallet and retry'
              : needsSignIn
                ? 'sign in to check'
                : currentlyHidden === null
                  ? 'checking…'
                  : currentlyHidden
                    ? 'hidden'
                    : 'visible'}
          </div>
          {matchedAddress && matchedAddress !== target.address.toLowerCase() && (
            <div className="break-all">
              <span className="text-muted uppercase tracking-wider mr-2">via sibling</span>
              {matchedAddress}
            </div>
          )}
        </div>
      )}

      {needsSignIn && (
        <button
          type="button"
          onClick={() => void startSession()}
          className="text-[10px] font-mono uppercase tracking-widest px-3 py-2 border border-line text-dim hover:text-ink hover:border-muted transition-colors w-fit"
        >
          sign in to load status
        </button>
      )}

      {target?.type === 'moment' && listings.kind !== 'idle' && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono text-dim uppercase tracking-wider">
            marketplace listings
          </span>
          {listings.kind === 'auth' ? (
            <button
              type="button"
              onClick={() => void startSession()}
              className="text-[10px] font-mono uppercase tracking-widest px-3 py-2 border border-line text-dim hover:text-ink hover:border-muted transition-colors w-fit"
            >
              sign in to load listings
            </button>
          ) : listings.kind === 'loading' ? (
            <p className="text-[10px] font-mono text-muted">loading listings…</p>
          ) : listings.kind === 'error' ? (
            <p className="text-[10px] font-mono text-muted">
              listings unavailable — sign in with the admin wallet and re-paste the link.
            </p>
          ) : (
            <>
              {(listings.momentHidden || listings.collectionHidden) && (
                <p className="text-[10px] font-mono text-[#c8a874]">
                  {listings.collectionHidden
                    ? 'collection is hidden — every listing below is off the market regardless of its own flag.'
                    : 'moment is hidden — every listing below is off the market regardless of its own flag.'}
                </p>
              )}
              {listings.rows.length === 0 ? (
                <p className="text-[10px] font-mono text-muted">no active listings for this moment.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {listings.rows.map((l) => (
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
            </>
          )}
        </div>
      )}

      {/* Destructive erase — profiles only. Hard, irreversible delete of the
          identity + everything the wallet authored/touched; reconnecting
          rebuilds a fresh profile. Two-tap arm/confirm. */}
      {target?.type === 'profile' && (
        <div className="flex flex-col gap-1.5 border border-[#5a2a2a] bg-[#1a1010] p-2.5">
          <span className="text-[10px] font-mono text-[#c87474] uppercase tracking-wider">
            danger — erase profile
          </span>
          <p className="text-[10px] font-mono text-dim leading-relaxed">
            Permanently deletes this identity and everything it authored on
            Kismet — profile, pins, follows (both directions), collected,
            notifications — across every verified wallet. On-chain content and
            earnings are untouched. Irreversible; reconnecting makes a fresh
            profile. Use for squatters and dead/abandoned accounts.
          </p>
          {eraseFcFid != null ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[10px] font-mono text-[#c8a874]">
                Erased a Farcaster identity — its FC name/avatar re-resolve
                from Farcaster (we can’t delete their FC account). Hide to
                suppress the residue too.
              </p>
              <button
                type="button"
                onClick={() => void hideFcResidue()}
                className="text-[10px] font-mono uppercase tracking-widest px-3 py-2 border border-line text-dim hover:text-ink hover:border-muted transition-colors w-fit"
              >
                also hide the FC identity
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => (eraseArmed ? void eraseProfile() : armErase())}
              disabled={erasing}
              className="text-[10px] font-mono uppercase tracking-widest px-3 py-2 border border-[#5a2a2a] text-[#c87474] hover:text-[#e08a8a] hover:border-[#7a3a3a] transition-colors w-fit disabled:opacity-50"
            >
              {erasing
                ? 'erasing…'
                : eraseArmed
                  ? 'tap again to permanently erase'
                  : 'sign & erase profile'}
            </button>
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
