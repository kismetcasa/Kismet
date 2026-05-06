'use client'

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { toast } from 'sonner'

const SESSION_KEY = 'kismetart:admin-session'
const SESSION_TTL = 4 * 60 * 60 * 1000 // 4 hours

interface AdminSession {
  signature: string
  timestamp: number
}

interface AdminContextValue {
  isAdmin: boolean
  session: AdminSession | null
  startSession: () => Promise<void>
  featuredKeys: Set<string>
  featuredCollectionAddrs: Set<string>
  toggleFeatured: (collectionAddress: string, tokenId: string) => Promise<void>
  toggleFeaturedCollection: (collectionAddress: string) => Promise<void>
}

const AdminContext = createContext<AdminContextValue>({
  isAdmin: false,
  session: null,
  startSession: async () => {},
  featuredKeys: new Set(),
  featuredCollectionAddrs: new Set(),
  toggleFeatured: async () => {},
  toggleFeaturedCollection: async () => {},
})

export function useAdmin() {
  return useContext(AdminContext)
}

export function AdminProvider({ children }: { children: React.ReactNode }) {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()

  const [isAdmin, setIsAdmin] = useState(false)
  const [session, setSession] = useState<AdminSession | null>(null)
  const sessionRef = useRef<AdminSession | null>(null)
  const [featuredKeys, setFeaturedKeys] = useState<Set<string>>(new Set())
  const [featuredCollectionAddrs, setFeaturedCollectionAddrs] = useState<Set<string>>(new Set())

  function applySession(s: AdminSession | null) {
    sessionRef.current = s
    setSession(s)
  }

  // Check admin status server-side so the address never ships in the client bundle
  useEffect(() => {
    if (!address) { setIsAdmin(false); return }
    fetch(`/api/admin/me?address=${address}`)
      .then((r) => r.json())
      .then((d) => setIsAdmin(d.isAdmin === true))
      .catch(() => setIsAdmin(false))
  }, [address])

  // Restore from sessionStorage once admin is confirmed; clear when not admin.
  // Combined into one effect so the restore never races with the clear.
  useEffect(() => {
    if (!isAdmin) {
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
  }, [isAdmin])

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
    if (!address || !isAdmin) return
    const timestamp = Date.now()
    const message = `Kismet Art admin session\nAddress: ${address.toLowerCase()}\nTimestamp: ${timestamp}`
    try {
      const signature = await signMessageAsync({ message })
      const s: AdminSession = { signature, timestamp }
      applySession(s)
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
    } catch (err) {
      toast.error('Failed to start admin session', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }, [address, isAdmin, signMessageAsync])

  const toggleFeatured = useCallback(
    async (collectionAddress: string, tokenId: string) => {
      if (!isAdmin) return

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
        toast.error('Failed to update featured', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    },
    [isAdmin, startSession, featuredKeys],
  )

  const toggleFeaturedCollection = useCallback(
    async (collectionAddress: string) => {
      if (!isAdmin) return

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
        toast.error('Failed to update featured', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    },
    [isAdmin, startSession, featuredCollectionAddrs],
  )

  return (
    <AdminContext.Provider
      value={{
        isAdmin,
        session,
        startSession,
        featuredKeys,
        featuredCollectionAddrs,
        toggleFeatured,
        toggleFeaturedCollection,
      }}
    >
      {children}
    </AdminContext.Provider>
  )
}
