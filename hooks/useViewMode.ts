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
// Grid mode is desktop-only. Below this width we always return 'feed'
// regardless of stored preference, and update() is a no-op so the
// preference can't be changed from a mobile context. Matches Tailwind's
// `md:` breakpoint that the ViewModeToggle uses to hide itself.
const DESKTOP_MQ = '(min-width: 768px)'

// SSR-safe init: defer the localStorage and matchMedia reads until
// after mount to avoid hydration mismatches. Both default to false /
// 'feed' on the server so the initial paint always matches the
// mobile/feed-mode tree; desktop users with a stored 'grid' preference
// see a one-frame swap to grid after hydration.
//
// All view-mode-aware feeds share the same storage key, so flipping
// the toggle once carries the preference to the next feed the user
// opens (main mints → trending stays in grid mode).
export function useViewMode(): [ViewMode, (next: ViewMode) => void] {
  const [mode, setMode] = useState<ViewMode>('feed')
  const [allowGrid, setAllowGrid] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_MQ)
    const onMqChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setAllowGrid(e.matches)
    }
    onMqChange(mql)
    mql.addEventListener('change', onMqChange)

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
      mql.removeEventListener('change', onMqChange)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(SYNC_EVENT, onSync)
    }
  }, [])

  // Below the desktop breakpoint, always feed — regardless of stored
  // value, and even if a desktop user resizes their window narrow.
  // The stored value is preserved so resizing back restores grid.
  const effectiveMode: ViewMode = allowGrid ? mode : 'feed'

  const update = useCallback((next: ViewMode) => {
    if (!allowGrid) return
    setMode(next)
    try { localStorage.setItem(STORAGE_KEY, next) } catch {}
    // Notify every other hook instance in this window. The originating
    // instance's setMode above handles its own update.
    window.dispatchEvent(new CustomEvent<ViewMode>(SYNC_EVENT, { detail: next }))
  }, [allowGrid])

  return [effectiveMode, update]
}
