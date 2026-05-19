'use client'

import { useCallback, useEffect, useState } from 'react'

export type ViewMode = 'feed' | 'grid'

const STORAGE_KEY = 'kismetart:view-mode'
// Broadcast channel for same-tab sync. The browser `storage` event
// only fires in OTHER windows/tabs, so without this, two useViewMode
// instances mounted in the same tree (MainFeed's toggle + the
// MomentFeed/CollectionsFeed it renders, or ProfileView's toggle +
// its child sections) drift apart — the toggle flips but the body
// stays in the old layout. update() dispatches this event so every
// instance's listener re-runs setMode in lockstep.
const SYNC_EVENT = 'kismetart:view-mode-changed'

// SSR-safe init: defer the localStorage read until after mount to avoid
// hydration mismatches. Toggle persists per-device and applies globally
// across every feed that opts in via <PaginatedGrid viewMode>.
//
// All view-mode-aware feeds share the same storage key, so flipping
// the toggle once carries the preference to the next feed the user
// opens (main mints → trending stays in grid mode).
export function useViewMode(): [ViewMode, (next: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>('feed')

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw === 'grid' || raw === 'feed') setMode(raw)
    } catch {}
    // Cross-tab sync — toggling in another window reflects here.
    function onStorage(e: StorageEvent) {
      if (e.key !== STORAGE_KEY) return
      if (e.newValue === 'grid' || e.newValue === 'feed') setMode(e.newValue)
    }
    // Same-tab sync — keeps sibling/child hook instances in lockstep
    // when any single instance calls `update`.
    function onSync(e: Event) {
      const next = (e as CustomEvent<ViewMode>).detail
      if (next === 'grid' || next === 'feed') setMode(next)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(SYNC_EVENT, onSync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SYNC_EVENT, onSync)
    }
  }, [])

  const update = useCallback((next: ViewMode) => {
    setMode(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
    // Notify every other hook instance in this window. The originating
    // instance's setMode above handles its own update.
    window.dispatchEvent(new CustomEvent<ViewMode>(SYNC_EVENT, { detail: next }))
  }, [])

  return [mode, update]
}
