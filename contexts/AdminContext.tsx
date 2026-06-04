'use client'

import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { base } from 'wagmi/chains'
import { createSiweMessage } from 'viem/siwe'
import { toastError } from '@/lib/toast'

const SESSION_KEY = 'kismetart:admin-session'
const SESSION_TTL_MS = 4 * 60 * 60 * 1000

interface AdminSession {
  // Local expiry marker only. The actual authentication is the HttpOnly
  // cookie set by POST /api/auth/login, which we can't read from JS. We
  // track expiresAt so UI surfaces can ask "do I have a session?" without
  // waiting for a 401 round-trip on the first request.
  expiresAt: number
  // The address that signed this session. Stored so a wallet switch can
  // invalidate the session locally + revoke the server cookie — otherwise
  // a user who signs in as A then switches to B in the wallet UI would
  // continue to act under A's auth.
  address: string
}

interface AdminContextValue {
  isAdmin: boolean
  // Curators share the admin's featured-feed permissions (add/remove
  // moments + collections) but get a dedicated panel on their own profile
  // instead of the per-card star button. The two roles can co-exist: an
  // address that is both admin and curator sees both surfaces.
  isCurator: boolean
  hasSession: boolean
  startSession: () => Promise<void>
  featuredKeys: Set<string>
  featuredCollectionAddrs: Set<string>
  // Mints promoted to a Mint Pass Display — the curated showcase atop the
  // featured tab. FeaturedMoment renders it as a rich hero on desktop and an
  // ordinary card on mobile (CSS picks which by viewport). Keyed
  // `<addr>:<tokenId>` (lowercase addr). A subset of featuredKeys
  // (DISPLAY ⊆ FEATURED), so demoting it leaves it featured rather than gone.
  mintPassKeys: Set<string>
  // Bumped on every successful curation toggle (and ONLY then — not by the
  // initial /api/featured load). Lets the featured tab remount-to-refetch on
  // a real change without remounting when the sets merely finish loading.
  featuredRevision: number
  toggleFeatured: (collectionAddress: string, tokenId: string) => Promise<void>
  toggleFeaturedCollection: (collectionAddress: string) => Promise<void>
  // Long-press affordance on the star: promote/demote a mint to a Mint Pass
  // Display. Promoting also features the mint (DISPLAY ⊆ FEATURED); demoting
  // leaves it featured.
  toggleMintPassDisplay: (collectionAddress: string, tokenId: string) => Promise<void>
  // Run `fn` with a valid privileged session in scope. Auto-prompts a
  // one-time SIWE signature + login round-trip if no session is active.
  // Returns whatever `fn` returns, or null if unprivileged / cancelled.
  // The HttpOnly cookie is auto-attached to fetches inside `fn`, so the
  // callback doesn't need to inject any auth params into request bodies.
  withSession: <T>(fn: () => Promise<T>) => Promise<T | null>
}

const AdminContext = createContext<AdminContextValue>({
  isAdmin: false,
  isCurator: false,
  hasSession: false,
  startSession: async () => {},
  featuredKeys: new Set(),
  featuredCollectionAddrs: new Set(),
  mintPassKeys: new Set(),
  featuredRevision: 0,
  toggleFeatured: async () => {},
  toggleFeaturedCollection: async () => {},
  toggleMintPassDisplay: async () => {},
  withSession: async () => null,
})

export function useAdmin() {
  return useContext(AdminContext)
}

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [isAdmin, setIsAdmin] = useState(false)
  const [isCurator, setIsCurator] = useState(false)
  const [session, setSession] = useState<AdminSession | null>(null)
  const sessionRef = useRef<AdminSession | null>(null)
  const [featuredKeys, setFeaturedKeys] = useState<Set<string>>(new Set())
  const [featuredCollectionAddrs, setFeaturedCollectionAddrs] = useState<Set<string>>(new Set())
  const [mintPassKeys, setMintPassKeys] = useState<Set<string>>(new Set())
  // Curation-change counter. Bumped by the toggles below (not the initial
  // fetch) so the featured tab can key off it to remount-and-refetch on a real
  // change without the wasteful double-fetch when the sets first populate.
  const [featuredRevision, setFeaturedRevision] = useState(0)
  const bumpFeaturedRevision = useCallback(() => setFeaturedRevision((v) => v + 1), [])

  function applySession(s: AdminSession | null) {
    sessionRef.current = s
    setSession(s)
  }

  // Check privileged status server-side so the addresses never ship in the
  // client bundle. Returns both isAdmin and isCurator flags in one call.
  useEffect(() => {
    if (!address) { setIsAdmin(false); setIsCurator(false); return }
    fetch(`/api/admin/me?address=${address}`)
      .then((r) => r.json())
      .then((d) => {
        setIsAdmin(d.isAdmin === true)
        setIsCurator(d.isCurator === true)
      })
      .catch(() => { setIsAdmin(false); setIsCurator(false) })
  }, [address])

  // Restore session marker from sessionStorage once a privileged role is
  // confirmed; clear otherwise. The marker is just a local expiry hint —
  // the source of truth is the HttpOnly cookie, so if a request 401s the
  // caller can re-trigger startSession() to refresh both.
  //
  // address is in the dep list so a wallet switch (A → B) tears down a
  // session bound to A: the marker has parsed.address === A which won't
  // match the new address, so we clear local state AND revoke the cookie
  // server-side. Without this, B would silently inherit A's admin rights
  // via the still-valid HttpOnly cookie.
  useEffect(() => {
    if (!isAdmin && !isCurator) {
      applySession(null)
      return
    }
    try {
      const raw = sessionStorage.getItem(SESSION_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as AdminSession
      const stillValid =
        parsed.expiresAt > Date.now() &&
        !!address &&
        parsed.address === address.toLowerCase()
      if (stillValid) {
        applySession(parsed)
      } else {
        sessionStorage.removeItem(SESSION_KEY)
        // Revoke the cookie too if the marker was for a different address
        // — covers the wallet-switch case where the cookie outlives our
        // local marker.
        if (parsed.address !== address?.toLowerCase()) {
          void fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
        }
      }
    } catch {}
  }, [isAdmin, isCurator, address])

  // Fetch featured keys on mount (both moments and whole collections)
  useEffect(() => {
    fetch('/api/featured')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.featured)) {
          setFeaturedKeys(
            new Set(
              d.featured.map(
                (f: { collectionAddress: string; tokenId: string }) =>
                  `${f.collectionAddress.toLowerCase()}:${f.tokenId}`,
              ),
            ),
          )
        }
        if (Array.isArray(d.featuredCollections)) {
          setFeaturedCollectionAddrs(
            new Set(
              d.featuredCollections.map(
                (f: { collectionAddress: string }) => f.collectionAddress.toLowerCase(),
              ),
            ),
          )
        }
        if (Array.isArray(d.mintPassDisplays)) {
          setMintPassKeys(
            new Set(
              d.mintPassDisplays.map(
                (f: { collectionAddress: string; tokenId: string }) =>
                  `${f.collectionAddress.toLowerCase()}:${f.tokenId}`,
              ),
            ),
          )
        }
      })
      .catch(() => {})
  }, [])

  // SIWE login dance. Each session begins by:
  //  1. Fetching a server-issued single-use nonce.
  //  2. Constructing an EIP-4361 SIWE message bound to (domain, address,
  //     chainId, nonce, expirationTime).
  //  3. Signing the message with the connected wallet.
  //  4. POSTing { message, signature } to /api/auth/login, which verifies
  //     the signature + nonce + domain and returns an HttpOnly cookie
  //     carrying an opaque session token (server-stored in Redis with the
  //     same 4h TTL we track locally below).
  // The signature itself never persists client-side; only the opaque cookie
  // and a local expiry marker remain.
  const startSession = useCallback(async () => {
    if (!address || (!isAdmin && !isCurator)) return
    try {
      const nonceRes = await fetch('/api/auth/nonce', { method: 'POST' })
      if (!nonceRes.ok) throw new Error('Failed to issue auth nonce')
      const { nonce } = (await nonceRes.json()) as { nonce: string }

      const issuedAt = new Date()
      const expirationTime = new Date(Date.now() + SESSION_TTL_MS)
      const message = createSiweMessage({
        domain: window.location.host,
        address: address as `0x${string}`,
        statement: 'Sign in to Kismet admin.',
        uri: window.location.origin,
        version: '1',
        chainId: base.id,
        nonce,
        issuedAt,
        expirationTime,
      })

      const signature = await signMessageAsync({ message })

      const loginRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      })
      if (!loginRes.ok) {
        const data = (await loginRes.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? 'Login failed')
      }

      const s: AdminSession = {
        expiresAt: expirationTime.getTime(),
        address: address.toLowerCase(),
      }
      applySession(s)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    } catch (err) {
      toastError('Sign in', err)
    }
  }, [address, isAdmin, isCurator, signMessageAsync])

  // Shared "ensure session, then call" wrapper used by every privileged
  // operation. Re-reads via ref after the async sign so a fresh login
  // settles in before the caller's fetch.
  //
  // The session-restore effect tears down stale markers on wallet change,
  // but there's a brief render-commit window where sessionRef can still
  // hold the previous wallet's marker. Validate the bound address here
  // too so a click that races the effect cleanup doesn't perform an
  // action under the prior wallet's auth.
  const ensureSession = useCallback(async (): Promise<AdminSession | null> => {
    const valid = (s: AdminSession | null) =>
      !!s &&
      s.expiresAt > Date.now() &&
      !!address &&
      s.address === address.toLowerCase()
    if (valid(sessionRef.current)) return sessionRef.current
    await startSession()
    return valid(sessionRef.current) ? sessionRef.current : null
  }, [address, startSession])

  const toggleFeatured = useCallback(
    async (collectionAddress: string, tokenId: string) => {
      if (!address || (!isAdmin && !isCurator)) return
      const s = await ensureSession()
      if (!s) return // user cancelled signing

      const key = `${collectionAddress.toLowerCase()}:${tokenId}`
      const isFeatured = featuredKeys.has(key)

      try {
        const res = await fetch('/api/featured', {
          method: isFeatured ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collectionAddress, tokenId }),
        })
        if (!res.ok) {
          const d = await res.json()
          throw new Error(d.error ?? 'Failed')
        }
        setFeaturedKeys((prev) => {
          const next = new Set(prev)
          if (isFeatured) next.delete(key)
          else next.add(key)
          return next
        })
        // Unfeaturing cascades: a mint that isn't featured can't be a Mint
        // Pass Display, so drop any hero treatment too (server does the same).
        if (isFeatured) {
          setMintPassKeys((prev) => {
            if (!prev.has(key)) return prev
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        }
        bumpFeaturedRevision()
      } catch (err) {
        toastError('Featured update', err)
      }
    },
    [address, isAdmin, isCurator, ensureSession, featuredKeys, bumpFeaturedRevision],
  )

  const toggleMintPassDisplay = useCallback(
    async (collectionAddress: string, tokenId: string) => {
      if (!address || (!isAdmin && !isCurator)) return
      const s = await ensureSession()
      if (!s) return // user cancelled signing

      const key = `${collectionAddress.toLowerCase()}:${tokenId}`
      const isDisplay = mintPassKeys.has(key)

      try {
        const res = await fetch('/api/featured', {
          method: isDisplay ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'momentDisplay', collectionAddress, tokenId }),
        })
        if (!res.ok) {
          const d = await res.json()
          throw new Error(d.error ?? 'Failed')
        }
        setMintPassKeys((prev) => {
          if (isDisplay) {
            const next = new Set(prev)
            next.delete(key)
            return next
          }
          // Single display at a time ("latest wins") — mirror the server
          // clearing the set on promote, so exactly one mint is ever the hero.
          return new Set([key])
        })
        // Promoting to a Mint Pass Display also features the mint (DISPLAY ⊆
        // FEATURED) so it still shows as a normal card on mobile. Demoting
        // leaves it featured.
        if (!isDisplay) {
          setFeaturedKeys((prev) => {
            if (prev.has(key)) return prev
            const next = new Set(prev)
            next.add(key)
            return next
          })
        }
        bumpFeaturedRevision()
      } catch (err) {
        toastError('Mint Pass Display update', err)
      }
    },
    [address, isAdmin, isCurator, ensureSession, mintPassKeys, bumpFeaturedRevision],
  )

  const withSession = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      if (!address || (!isAdmin && !isCurator)) return null
      const s = await ensureSession()
      if (!s) return null
      return fn()
    },
    [address, isAdmin, isCurator, ensureSession],
  )

  const toggleFeaturedCollection = useCallback(
    async (collectionAddress: string) => {
      if (!address || (!isAdmin && !isCurator)) return
      const s = await ensureSession()
      if (!s) return

      const key = collectionAddress.toLowerCase()
      const isFeatured = featuredCollectionAddrs.has(key)

      try {
        const res = await fetch('/api/featured', {
          method: isFeatured ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'collection', collectionAddress }),
        })
        if (!res.ok) {
          const d = await res.json()
          throw new Error(d.error ?? 'Failed')
        }
        setFeaturedCollectionAddrs((prev) => {
          const next = new Set(prev)
          if (isFeatured) next.delete(key)
          else next.add(key)
          return next
        })
        bumpFeaturedRevision()
      } catch (err) {
        toastError('Featured update', err)
      }
    },
    [address, isAdmin, isCurator, ensureSession, featuredCollectionAddrs, bumpFeaturedRevision],
  )

  // Memoized so useAdmin() consumers only re-render when these fields
  // change — without it, every AdminProvider render hands children a
  // fresh object literal and forces a re-render across the tree.
  const value = useMemo(
    () => ({
      isAdmin,
      isCurator,
      hasSession:
        session !== null &&
        session.expiresAt > Date.now() &&
        !!address &&
        session.address === address.toLowerCase(),
      startSession,
      featuredKeys,
      featuredCollectionAddrs,
      mintPassKeys,
      featuredRevision,
      toggleFeatured,
      toggleFeaturedCollection,
      toggleMintPassDisplay,
      withSession,
    }),
    [
      isAdmin, isCurator, session, address,
      startSession,
      featuredKeys, featuredCollectionAddrs, mintPassKeys, featuredRevision,
      toggleFeatured, toggleFeaturedCollection, toggleMintPassDisplay, withSession,
    ],
  )

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>
}
