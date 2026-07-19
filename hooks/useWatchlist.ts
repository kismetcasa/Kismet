'use client'

import { useCallback, useSyncExternalStore } from 'react'

/**
 * Local-only watchlist of moments, stored as small render snapshots so the
 * watchlist view can draw ovals with zero backend (price/supply still resolve
 * live through the ovals' own dwell-gated reads). A module-level store with
 * useSyncExternalStore keeps every star button and the view in sync without a
 * context provider; wallet-less by design — it's a browsing bookmark, not
 * portfolio state.
 */
export interface WatchlistEntry {
  address: string
  tokenId: string
  name?: string
  image?: string
  collection?: string
  creator?: string
  createdAt?: string
  addedAt: number
}

const KEY = 'kismetart:watchlist'
const MAX_ENTRIES = 200

let cache: WatchlistEntry[] | null = null
const listeners = new Set<() => void>()
const EMPTY: WatchlistEntry[] = []

function read(): WatchlistEntry[] {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as WatchlistEntry[]) : []
    cache = Array.isArray(parsed) ? parsed : []
  } catch {
    cache = []
  }
  return cache
}

function write(next: WatchlistEntry[]): void {
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {}
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const keyOf = (address: string, tokenId: string) => `${address.toLowerCase()}:${tokenId}`

export function useWatchlist() {
  const entries = useSyncExternalStore(
    subscribe,
    read,
    // SSR snapshot: empty — stars hydrate unfilled, then flip on the client's
    // first paint after hydration (no server/client markup mismatch).
    () => EMPTY,
  )

  const has = useCallback(
    (address: string, tokenId: string) =>
      entries.some((e) => keyOf(e.address, e.tokenId) === keyOf(address, tokenId)),
    [entries],
  )

  const toggle = useCallback((entry: Omit<WatchlistEntry, 'addedAt'>) => {
    const current = read()
    const k = keyOf(entry.address, entry.tokenId)
    const without = current.filter((e) => keyOf(e.address, e.tokenId) !== k)
    if (without.length !== current.length) {
      write(without)
    } else {
      // Newest first; bounded so the snapshot list can't grow unbounded.
      write([{ ...entry, addedAt: Date.now() }, ...current].slice(0, MAX_ENTRIES))
    }
  }, [])

  return { entries, has, toggle }
}
