'use client'

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { toastError } from '@/lib/toast'

const SESSION_KEY = 'kismetart:admin-session'
const SESSION_TTL = 4 * 60 * 60 * 1000 // 4 hours

interface AdminSession {
  signature: string
  timestamp: number
}

/** Auth fields a curator/admin call to a privileged endpoint must include. */
export interface PrivilegedAuth {
  signature: string
  timestamp: number
  signerAddress: string
}

interface AdminContextValue {
  isAdmin: boolean
  // Curators share the admin's featured-feed permissions (add/remove
  // moments + collections) but get a dedicated panel on their own profile
  // instead of the per-card star button. The two roles can co-exist: an
  // address that is both admin and curator sees both surfaces.
  isCurator: boolean
  session: AdminSession | null
  startSession: () => Promise<void>
  featuredKeys: Set<string>
  featuredCollectionAddrs: Set<string>
  toggleFeatured: (collectionAddress: string, tokenId: string) => Promise<void>
  toggleFeaturedCollection: (collectionAddress: string) => Promise<void>
  // Run `fn` with a valid privileged session, auto-prompting a one-time
  // signature if none is cached. Returns whatever `fn` returns, or null
  // when the caller isn't privileged or cancels the signature prompt.
  // Used by curator surfaces (creator-list editor) so they don't have
  // to re-implement the session dance that toggleFeatured does.
  withSession: <T>(fn: (auth: PrivilegedAuth) => Promise<T>) => Promise<T | null>
}

const AdminContext = createContext<AdminContextValue>({
  isAdmin: false,
  isCurator: false,
  session: null,
  startSession: async () => {},
  featuredKeys: new Set(),
  featuredCollectionAddrs: new Set(),
  toggleFeatured: async () => {},
  toggleFeaturedCollection: async () => {},
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

  // Restore from sessionStorage once a privileged role is confirmed; clear
  // otherwise. Combined into one effect so the restore never races with
  // the clear. Both admins and curators use the same session key — the
  // server verifies signerAddress, so cross-role mixups are impossible.
  useEffect(() => {
    if (!isAdmin && !isCurator) {
      applySession(null)
      return
    }
    try {
      const raw = sessionStorage.getItem(SESSION_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as AdminSession
      if (Date.now() - parsed.timestamp < SESSION_TTL) {
        applySession(parsed)
      } else {
        sessionStorage.removeItem(SESSION_KEY)
      }
    } catch {}
  }, [isAdmin, isCurator])

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
      })
      .catch(() => {})
  }, [])

  const startSession = useCallback(async () => {
    if (!address || (!isAdmin && !isCurator)) return
    const timestamp = Date.now()
    const message = `Kismet Art admin session\nAddress: ${address.toLowerCase()}\nTimestamp: ${timestamp}`
    try {
      const signature = await signMessageAsync({ message })
      const s: AdminSession = { signature, timestamp }
      applySession(s)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    } catch (err) {
      toastError('Sign in', err)
    }
  }, [address, isAdmin, isCurator, signMessageAsync])

  const toggleFeatured = useCallback(
    async (collectionAddress: string, tokenId: string) => {
      if (!address || (!isAdmin && !isCurator)) return

      // Auto-start session if needed; re-read via ref after async sign
      let s = sessionRef.current
      if (!s) {
        await startSession()
        s = sessionRef.current
        if (!s) return // user cancelled signing
      }

      const key = `${collectionAddress.toLowerCase()}:${tokenId}`
      const isFeatured = featuredKeys.has(key)

      try {
        const res = await fetch('/api/featured', {
          method: isFeatured ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collectionAddress,
            tokenId,
            signature: s.signature,
            timestamp: s.timestamp,
            signerAddress: address,
          }),
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
      } catch (err) {
        toastError('Featured update', err)
      }
    },
    [address, isAdmin, isCurator, startSession, featuredKeys],
  )

  const withSession = useCallback(
    async <T,>(fn: (auth: PrivilegedAuth) => Promise<T>): Promise<T | null> => {
      if (!address || (!isAdmin && !isCurator)) return null
      let s = sessionRef.current
      if (!s) {
        await startSession()
        s = sessionRef.current
        if (!s) return null
      }
      return fn({ signature: s.signature, timestamp: s.timestamp, signerAddress: address })
    },
    [address, isAdmin, isCurator, startSession],
  )

  const toggleFeaturedCollection = useCallback(
    async (collectionAddress: string) => {
      if (!address || (!isAdmin && !isCurator)) return

      let s = sessionRef.current
      if (!s) {
        await startSession()
        s = sessionRef.current
        if (!s) return
      }

      const key = collectionAddress.toLowerCase()
      const isFeatured = featuredCollectionAddrs.has(key)

      try {
        const res = await fetch('/api/featured', {
          method: isFeatured ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'collection',
            collectionAddress,
            signature: s.signature,
            timestamp: s.timestamp,
            signerAddress: address,
          }),
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
      } catch (err) {
        toastError('Featured update', err)
      }
    },
    [address, isAdmin, isCurator, startSession, featuredCollectionAddrs],
  )

  return (
    <AdminContext.Provider
      value={{
        isAdmin,
        isCurator,
        session,
        startSession,
        featuredKeys,
        featuredCollectionAddrs,
        toggleFeatured,
        toggleFeaturedCollection,
        withSession,
      }}
    >
      {children}
    </AdminContext.Provider>
  )
}
