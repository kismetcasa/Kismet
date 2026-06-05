'use client'

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * How many items at the start of a list mount eagerly when lazy mode
 * is active. Cards beyond this index defer mount until their placeholder
 * enters the viewport.
 *
 * Only consulted on the lazy=true path (server-detected mobile UAs).
 * Desktop runs with lazy=false and never instantiates LazyMount, so this
 * constant is effectively a mobile-only knob — desktop stays unlimited-
 * eager regardless of the value here.
 *
 * 4 ≈ one mobile viewport at the 2-col grid we use everywhere on phones.
 * Lower than 4 starts producing visible placeholder pop-in on first paint;
 * higher and we re-introduce the click-through pause on heavy feeds.
 */
const EAGER_MOUNT_COUNT = 4

// Mount this far before the viewport — just enough to hide pop-in on a
// normal scroll while the browser fetches/decodes the image. Kept tight on
// purpose: a larger margin mounts more heavy cards at once, which lengthens
// the render-in burst. Reducing per-card mount cost is the lever for pop-in,
// not a wider margin.
const MOUNT_MARGIN = '200px'

// Unmount once a card is this far OUTSIDE the viewport. Deliberately huge
// relative to MOUNT_MARGIN: the gap is hysteresis so a card lingering near
// one edge can't thrash mount↔unmount. By the time a card is 3000px
// offscreen its inline <video> has long since been paused by its own
// IntersectionObserver, so unmounting the card frees the element + decoder
// cleanly with no churn.
const UNMOUNT_MARGIN = '3000px'

interface LazyMountProps {
  /** Render-prop: only invoked once the placeholder enters the IO window.
   *  Use a render-prop (not children prop) so any expensive JSX construction
   *  by the parent is also deferred — passing `<HeavyComponent/>` as children
   *  would build the element on every render of LazyMount regardless. */
  children: () => ReactNode
  /** Distance from the viewport at which to start mounting. 200px gives the
   *  browser time to fetch/decode images before the card scrolls into the
   *  visible area, avoiding pop-in on normal scroll. */
  rootMargin?: string
  /** Placeholder className, applied to the reservation div before mount. */
  placeholderClassName?: string
}

const DEFAULT_PLACEHOLDER = (
  <>
    <div className="aspect-square bg-raised" />
    <div className="p-4 space-y-2 h-20">
      <div className="h-3 w-2/3 bg-raised rounded" />
      <div className="h-3 w-1/3 bg-raised rounded" />
    </div>
  </>
)

/**
 * Mount the wrapped content while it's near the viewport and UNMOUNT it
 * once it scrolls far away (`UNMOUNT_MARGIN`), reclaiming its DOM nodes,
 * decoded poster bitmap, and inline video element + decoder. Bidirectional windowing —
 * the wrapper div persists across mount/unmount so the two
 * IntersectionObservers keep tracking it, and the rendered height is
 * snapshotted before unmount and reapplied as the placeholder's
 * min-height so the scroll position never jumps.
 *
 * NEVER instantiated on desktop: the only callers (PaginatedGrid /
 * MaybeLazy) gate use on a `lazy` prop the discover page sets to `false`
 * on desktop UAs. Server-side UA detection bakes the decision into the
 * SSR HTML — no client-side flip, no hydration window where desktop
 * briefly sees the lazy tree.
 */
export function LazyMount({
  children,
  rootMargin = MOUNT_MARGIN,
  placeholderClassName,
}: LazyMountProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  // Rendered height while mounted, reused as the placeholder's min-height
  // after unmount so reclaiming the card doesn't collapse its cell and
  // jump the scroll position.
  const heightRef = useRef(0)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    const mountObs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setMounted(true)
      },
      { rootMargin },
    )
    const unmountObs = new IntersectionObserver(
      ([entry]) => {
        if (entry && !entry.isIntersecting) {
          const h = node.getBoundingClientRect().height
          if (h > 0) heightRef.current = h
          setMounted(false)
        }
      },
      { rootMargin: UNMOUNT_MARGIN },
    )
    // The wrapper node is stable across mount/unmount, so the observers
    // are set up once and never re-attached on toggle.
    mountObs.observe(node)
    unmountObs.observe(node)
    return () => {
      mountObs.disconnect()
      unmountObs.disconnect()
    }
  }, [rootMargin])

  return (
    <div
      ref={ref}
      // Mounted: a single-cell grid (grid-rows-1) that stretches the card to
      // fill the wrapper, so in a row sized to its tallest item (every card
      // grid) a lazy card matches the eager direct-grid-item cards beside it.
      // No-op where the wrapper isn't stretched (single-column feed, swipe).
      className={mounted ? 'grid grid-rows-1' : (placeholderClassName ?? 'bg-[#161616] border border-line overflow-hidden')}
      style={!mounted && heightRef.current ? { minHeight: heightRef.current } : undefined}
      aria-hidden={mounted ? undefined : true}
    >
      {mounted ? children() : DEFAULT_PLACEHOLDER}
    </div>
  )
}

/**
 * Conditional lazy-mount wrapper for use inside grid maps that aren't
 * paginated (ProfileView, CollectionView). When `lazy` is false (every
 * desktop caller), renders children inline as a Fragment — zero overhead.
 * When `lazy` is true AND index is beyond EAGER_MOUNT_COUNT, wraps in
 * LazyMount.
 *
 * Caller MUST set `key` on this component itself, not on the inner
 * element — both branches render different React types, so the key has
 * to live on the outer position to stay stable across mount/unmount.
 */
export function MaybeLazy({
  index,
  lazy,
  children,
}: {
  index: number
  lazy: boolean
  children: () => ReactNode
}) {
  if (!lazy || index < EAGER_MOUNT_COUNT) {
    return <Fragment>{children()}</Fragment>
  }
  return <LazyMount>{children}</LazyMount>
}
