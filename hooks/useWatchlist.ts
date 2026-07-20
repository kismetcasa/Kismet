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
  /** Legacy — no longer written or rendered (oval subtitles carry market data
   *  only); kept so rows stored before the change still parse untouched. */
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
    const parsed: unknown = raw ? JSON.parse(raw) : []
    // Shape-validate every element, not just the array: keyOf calls
    // .toLowerCase() on address during every oval render, so one corrupt or
    // legacy row without a string address would crash-loop the whole page
    // until storage is cleared. Drop bad rows instead.
    cache = Array.isArray(parsed)
      ? (parsed as WatchlistEntry[]).filter(
          (e) => !!e && typeof e.address === 'string' && typeof e.tokenId === 'string',
        )
      : []
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

// Cross-tab sync: another tab's toggle fires the storage event here; dropping
// the cache makes the next snapshot re-read the authoritative stored value, so
// stars converge instead of this tab later clobbering the other's additions
// with its stale array. Installed lazily on first subscribe (SSR-safe) and
// never removed — it's one module-lifetime listener, not per-hook.
let storageSyncInstalled = false
function installStorageSync(): void {
  if (storageSyncInstalled || typeof window === 'undefined') return
  storageSyncInstalled = true
  window.addEventListener('storage', (e) => {
    // e.key === null means the whole store was cleared.
    if (e.key !== KEY && e.key !== null) return
    cache = null
    listeners.forEach((l) => l())
  })
}

function subscribe(listener: () => void): () => void {
  installStorageSync()
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
