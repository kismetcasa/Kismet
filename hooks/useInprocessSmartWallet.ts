'use client'

import { useEffect, useState } from 'react'

// Per-artist module-level cache: each EOA on inprocess has its own
// smart-wallet address, so the cache key is the lowercase artist EOA.
// Two adjacent surfaces (e.g. CollectionView + CreateCollectionForm) for
// the same artist coalesce on a single in-flight fetch via `inFlight`.
const cache = new Map<string, string | null>()
const inFlight = new Map<string, Promise<string | null>>()

// Without a timeout, a stalled inprocess /smartwallet upstream hangs this
// fetch indefinitely. On the deploy path that means CreateCollectionForm
// awaits the lookup forever before it ever reaches writeContractAsync, so
// the UI sits on "Deploying…" and no transaction is ever proposed.
const FETCH_TIMEOUT_MS = 12_000

async function load(artistWallet: string): Promise<string | null> {
  const key = artistWallet.toLowerCase()
  if (cache.has(key)) return cache.get(key) ?? null
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    try {
      const res = await fetch(
        `/api/inprocess/smart-wallet?artist_wallet=${encodeURIComponent(key)}`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      )
      if (!res.ok) return null
      const data = (await res.json()) as { address?: string }
      const addr = typeof data?.address === 'string' ? data.address : null
      // Only cache successful resolutions. Caching null would poison every
      // subsequent attempt (deploy, authorize banner) until a full reload,
      // turning a transient blip into a permanent failure.
      if (addr) cache.set(key, addr)
      return addr
    } catch {
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, promise)
  return promise
}

/**
 * Imperative resolver — returns the cached value when available, else
 * triggers (or joins) the single in-flight fetch for that artist. Use
 * from inside an async handler when you need the address exactly once
 * at action time and want to await it (e.g. CreateCollectionForm).
 */
export async function fetchInprocessSmartWallet(
  artistWallet: string,
): Promise<string | null> {
  return load(artistWallet)
}

/**
 * Reactive hook — subscribes a component to the resolved address for
 * the given artist EOA. Returns `{ address: null, loading: true }`
 * before the fetch lands, then re-renders with the cached value (or
 * null on failure) once it does. Pass `undefined` when the artist
 * isn't known yet (e.g. CollectionView before defaultAdminAddress
 * loads); the hook returns idle state and skips the fetch.
 */
export function useInprocessSmartWallet(
  artistWallet: string | undefined,
): { address: string | null; loading: boolean } {
  const key = artistWallet ? artistWallet.toLowerCase() : null
  const [address, setAddress] = useState<string | null>(
    key && cache.has(key) ? (cache.get(key) ?? null) : null,
  )
  const [loading, setLoading] = useState<boolean>(!!key && !cache.has(key))

  useEffect(() => {
    if (!key) {
      setAddress(null)
      setLoading(false)
      return
    }
    if (cache.has(key)) {
      setAddress(cache.get(key) ?? null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    load(key).then((a) => {
      if (cancelled) return
      setAddress(a)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [key])

  return { address, loading }
}
