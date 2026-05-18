'use client'

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import { gatewayUrls } from '@/lib/arweave/gateways'

/**
 * Persistent shared <video> element pool. Lives in the root layout so its
 * elements survive route transitions — the whole point of the abstraction.
 *
 * Architecture:
 *   - One <video> element per canonical src, owned by the pool.
 *   - Surfaces (cards, detail pages, etc.) register "slots" — empty divs
 *     in their own React tree that act as positioning anchors.
 *   - The pool CSS-positions the video element (position: fixed) to
 *     overlay whichever slot is currently active.
 *   - When the active slot unmounts (e.g. route change), the element
 *     stays alive for a 1-second grace window — long enough for the
 *     next surface to register and claim it without a remount.
 *   - When two surfaces claim the same src simultaneously (Plan C +
 *     Intercepting Routes case: feed card slot still mounted while the
 *     overlay slot mounts on top), "most recently mounted" wins. When
 *     the overlay releases, the pool falls back to the still-registered
 *     card slot immediately, no grace timer needed.
 *
 * What persists by virtue of the element surviving:
 *   - Decoder state (no re-decode flicker on transition).
 *   - currentTime, paused, volume, muted, buffered ranges.
 *   - The HTTP cache context the browser maintains for the element.
 *
 * What lives per-surface (NOT in the pool):
 *   - Poster image rendering (MomentImg in MomentVideo).
 *   - Thumbhash blur.
 *   - posterFailed / videoFailed state for graceful degradation.
 */

// Overlay surfaces (intercepting-route modals, lightbox) wrap their
// children in <SharedVideoZIndexProvider> to override the z-index any
// nested <SharedVideoSlot> uses — so the video stacks above the
// overlay's backdrop instead of being hidden behind it.

const SharedVideoZIndexCtx = createContext<number | undefined>(undefined)

export function SharedVideoZIndexProvider({
  zIndex,
  children,
}: {
  zIndex: number
  children: ReactNode
}) {
  return (
    <SharedVideoZIndexCtx.Provider value={zIndex}>
      {children}
    </SharedVideoZIndexCtx.Provider>
  )
}

export function useSharedVideoZIndex(): number | undefined {
  return useContext(SharedVideoZIndexCtx)
}

// ─── Pool types ──────────────────────────────────────────────────────

interface Slot {
  ref: HTMLElement
  controls: boolean
  zIndex: number
  /** Fired when every gateway has errored — caller drops the slot and
   *  shows the poster-only fallback. */
  onError?: () => void
  /** Clipping ancestors (overflow auto/scroll/hidden) above the slot.
   *  Cached on mount by SharedVideoSlot so positionElement doesn't
   *  walk the parent chain + call getComputedStyle on every refresh
   *  during a scroll (60Hz on most devices). */
  clipAncestors: HTMLElement[]
}

interface ManagedVideo {
  el: HTMLVideoElement
  /** All currently-registered slots for this src, most-recently-mounted
   *  first. The 0th entry is the "active" slot the element is positioned
   *  over. */
  slots: Slot[]
  releaseTimer: number | null
  /** Cancels the "drop the transition after the morph" timeout. Reset
   *  on each activateSlot so back-to-back route transitions don't strand
   *  the element in transitioning state after the second one finishes. */
  transitionTimer: number | null
  observer: IntersectionObserver | null
  gateways: string[]
  gatewayIndex: number
  loaded: boolean
  lastActiveAt: number
  /** Set true by destroyVideo so the event listeners can bail if they
   *  fire after teardown (the AbortSignal removes them but a queued
   *  event may still be dispatched). */
  destroyed: boolean
  /** Removes both event listeners on the video element in one shot. */
  abort: AbortController
  /** Last-applied rect for the dirty-check in positionElement — scroll
   *  fires per-pixel and most ticks don't move the slot. NaN sentinels
   *  guarantee the first call writes. */
  lastTop: number
  lastLeft: number
  lastWidth: number
  lastHeight: number
}

interface ContextValue {
  /** Register a slot for `src`. Returns a release fn to call on unmount. */
  acquire: (src: string, slot: Slot) => () => void
  /** Recompute the active slot's position (call on scroll / resize). */
  refresh: (src: string) => void
}

const Ctx = createContext<ContextValue | null>(null)

export function useSharedVideoContext(): ContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) {
    throw new Error(
      'useSharedVideoContext must be used inside <SharedVideoProvider>',
    )
  }
  return ctx
}

// ─── Tuning ──────────────────────────────────────────────────────────

// Grace window after a slot releases — long enough for the next surface
// to claim the element on a route transition without re-creating it.
const RELEASE_GRACE_MS = 1000

// Pool entries with no active slot for this long get destroyed.
const IDLE_EVICT_MS = 5 * 60 * 1000

// Hard cap on pool size. Past this, idle entries get evicted on next
// acquire. Larger pool = more decoder warmth on scroll-back (currentTime
// and buffered ranges survive while the entry is pooled).
const MAX_POOL_SIZE = 12

// ─── Helpers ─────────────────────────────────────────────────────────

/** Walk up the parent chain collecting any ancestor with overflow set
 *  to auto / scroll / hidden on either axis. Used by SharedVideoSlot
 *  to attach scroll listeners (so the fixed-position video tracks the
 *  slot when an inner scroller scrolls) and by positionElement to
 *  derive the clip-path that confines the video to those clipping
 *  ancestors' visible bounds. */
export function scrollableAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const style = getComputedStyle(node)
    const overflows = `${style.overflow} ${style.overflowX} ${style.overflowY}`
    if (/(auto|scroll|hidden)/.test(overflows)) out.push(node)
    node = node.parentElement
  }
  return out
}

/** Intersect every clipping-ancestor's content rect to derive the
 *  visible-bounds rectangle the slot lives inside. Returns null when
 *  there are no clipping ancestors (slot can paint to the viewport
 *  freely). */
function computeClipRect(ancestors: HTMLElement[]): DOMRect | null {
  if (ancestors.length === 0) return null
  let top = -Infinity
  let left = -Infinity
  let bottom = Infinity
  let right = Infinity
  for (const a of ancestors) {
    const r = a.getBoundingClientRect()
    if (r.top > top) top = r.top
    if (r.left > left) left = r.left
    if (r.bottom < bottom) bottom = r.bottom
    if (r.right < right) right = r.right
  }
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top))
}

// ─── Provider ────────────────────────────────────────────────────────

export function SharedVideoProvider({ children }: { children: ReactNode }) {
  const poolRef = useRef<Map<string, ManagedVideo>>(new Map())

  /** Split from `applySlotGeometry` so the batched scroll handler can
   *  do every read across the pool before any write — fastdom pattern;
   *  interleaving forces a sync reflow per video per frame on WebKit. */
  function readSlotGeometry(slot: Slot) {
    return {
      rect: slot.ref.getBoundingClientRect(),
      clip: computeClipRect(slot.clipAncestors),
    }
  }

  function applySlotGeometry(
    video: ManagedVideo,
    slot: Slot,
    rect: DOMRect,
    clip: DOMRect | null,
  ) {
    const el = video.el
    // translate3d is GPU-composited; top/left would force layout per
    // scroll frame on WebKit. width/height still trigger layout when
    // they change, but only during the 220ms morph.
    const positionChanged =
      rect.top !== video.lastTop || rect.left !== video.lastLeft
    const sizeChanged =
      rect.width !== video.lastWidth || rect.height !== video.lastHeight
    if (positionChanged) {
      el.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`
      video.lastTop = rect.top
      video.lastLeft = rect.left
    }
    if (sizeChanged) {
      el.style.width = `${rect.width}px`
      el.style.height = `${rect.height}px`
      video.lastWidth = rect.width
      video.lastHeight = rect.height
    }
    el.style.zIndex = String(slot.zIndex)
    el.style.pointerEvents = slot.controls ? 'auto' : 'none'
    el.controls = slot.controls
    // preload="auto" on committed-viewing surfaces (detail page, lightbox)
    // so the browser buffers aggressively; "metadata" on previews so a
    // grid of cards doesn't saturate bandwidth simultaneously.
    el.preload = slot.controls ? 'auto' : 'metadata'

    // Clip the element to its nearest clipping ancestor. position:fixed
    // ignores the ancestor's overflow, so a slot inside a horizontal
    // scroller (e.g. featured collection's mobile mints row) would
    // otherwise paint the video outside the scroller's bounds when
    // scrolled past the edge. clip-path keeps the element's bounds
    // visible only where the slot itself is visible.
    if (clip) {
      const top = Math.max(0, clip.top - rect.top)
      const right = Math.max(0, rect.right - clip.right)
      const bottom = Math.max(0, rect.bottom - clip.bottom)
      const left = Math.max(0, clip.left - rect.left)
      const fullyOutside =
        rect.right <= clip.left ||
        rect.left >= clip.right ||
        rect.bottom <= clip.top ||
        rect.top >= clip.bottom
      if (fullyOutside) {
        // Belt: clip-path inset to 100% reduces paint area to zero.
        // Suspenders: visibility:hidden so the element doesn't even
        // participate in the next compositor pass.
        el.style.clipPath = 'inset(100%)'
        el.style.visibility = 'hidden'
        return
      }
      el.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`
    } else {
      el.style.clipPath = ''
    }
    if (video.loaded) el.style.visibility = 'visible'
  }

  function positionElement(video: ManagedVideo, slot: Slot) {
    const { rect, clip } = readSlotGeometry(slot)
    applySlotGeometry(video, slot, rect, clip)
  }

  function activateSlot(video: ManagedVideo, slot: Slot) {
    if (video.releaseTimer !== null) {
      clearTimeout(video.releaseTimer)
      video.releaseTimer = null
    }
    if (video.transitionTimer !== null) {
      clearTimeout(video.transitionTimer)
      video.transitionTimer = null
    }
    video.lastActiveAt = Date.now()
    // Apply the morph only when re-positioning an already-visible
    // element (the card→overlay route-transition case). Fresh mounts
    // and re-acquires after the element was hidden snap straight to
    // the new position — otherwise the first paint would tween from
    // wherever the element happened to be sitting before, and every
    // card appearing in the feed would open a 220ms window during
    // which scrolls drag instead of snap.
    //
    // FUTURE: "fun mode" toggle that keeps the morph transition
    // permanently active (the original behaviour — transition was set
    // once in createVideo and never cleared) so videos trail behind
    // the slot on scroll. Reads as a liquid/floaty motion when many
    // cards are visible at once. Could extend to gifs (which render
    // through MomentImage today and would need their own
    // slot/anchor pattern, but the visual idea is the same). Gate
    // behind a user setting.
    if (video.el.style.visibility === 'visible') {
      video.el.style.transition =
        'transform 0.18s ease, width 0.18s ease, height 0.18s ease'
      video.transitionTimer = window.setTimeout(() => {
        video.el.style.transition = 'none'
        video.transitionTimer = null
      }, 220)
    } else {
      // Defensive: a rapid acquire/release/acquire cycle within 220ms
      // could leave the prior morph's transition still set. Reset
      // explicitly so the snap path stays snappy.
      video.el.style.transition = 'none'
    }
    positionElement(video, slot)

    // Replace any prior IntersectionObserver. Controlled surfaces
    // (detail page, lightbox) skip IO — the user owns play/pause there.
    video.observer?.disconnect()
    video.observer = null
    if (!slot.controls) {
      const io = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            video.el.play().catch(() => {})
          } else {
            video.el.pause()
          }
        },
        // Tight margin keeps the simultaneous-decoder count close to
        // "what's actually visible" — wider values let WebKit pile up
        // concurrent decoders fast enough to jank scroll.
        { threshold: 0.01, rootMargin: '50px' },
      )
      io.observe(slot.ref)
      video.observer = io
    }
  }

  function deactivate(video: ManagedVideo) {
    video.observer?.disconnect()
    video.observer = null
    video.el.style.visibility = 'hidden'
    video.el.pause()
  }

  function destroyVideo(video: ManagedVideo) {
    video.destroyed = true
    video.observer?.disconnect()
    if (video.releaseTimer !== null) clearTimeout(video.releaseTimer)
    if (video.transitionTimer !== null) clearTimeout(video.transitionTimer)
    video.abort.abort()
    video.el.pause()
    video.el.removeAttribute('src')
    video.el.load()
    video.el.remove()
  }

  function evictIdleIfOverCap() {
    if (poolRef.current.size <= MAX_POOL_SIZE) return
    const candidates: Array<{ src: string; video: ManagedVideo }> = []
    poolRef.current.forEach((video, src) => {
      if (video.slots.length === 0) candidates.push({ src, video })
    })
    candidates.sort((a, b) => a.video.lastActiveAt - b.video.lastActiveAt)
    const oldest = candidates[0]
    if (oldest) {
      destroyVideo(oldest.video)
      poolRef.current.delete(oldest.src)
    }
  }

  function createVideo(src: string): ManagedVideo {
    const gateways = gatewayUrls(src)
    const el = document.createElement('video')
    el.autoplay = true
    el.muted = true
    el.loop = true
    el.playsInline = true
    el.preload = 'metadata'
    el.style.position = 'fixed'
    // Anchor the element at the viewport origin and let positionElement
    // drive placement via transform — keeps scroll-tracking on the GPU.
    el.style.top = '0'
    el.style.left = '0'
    el.style.objectFit = 'contain'
    el.style.visibility = 'hidden'
    el.style.opacity = '0'
    // Transition is set only by activateSlot for the duration of the
    // morph and cleared right after — so scroll-driven repositions go
    // through without easing and the video tracks the slot per-frame.
    el.style.transition = 'none'

    const abort = new AbortController()
    const video: ManagedVideo = {
      el,
      slots: [],
      releaseTimer: null,
      transitionTimer: null,
      observer: null,
      gateways,
      gatewayIndex: 0,
      loaded: false,
      lastActiveAt: Date.now(),
      destroyed: false,
      abort,
      lastTop: NaN,
      lastLeft: NaN,
      lastWidth: NaN,
      lastHeight: NaN,
    }

    el.addEventListener('error', () => {
      if (video.destroyed) return
      const next = video.gatewayIndex + 1
      if (next < video.gateways.length) {
        video.gatewayIndex = next
        el.src = video.gateways[next]!
      } else {
        // Snapshot + clear slots first so the synchronous onError
        // callbacks (which set videoFailed=true → unmount the slot →
        // release()) find an empty list and bail harmlessly. Then
        // tear down the orphaned element so it doesn't sit in body
        // for IDLE_EVICT_MS.
        const slotsToNotify = video.slots
        video.slots = []
        slotsToNotify.forEach((s) => s.onError?.())
        destroyVideo(video)
        poolRef.current.delete(src)
      }
    }, { signal: abort.signal })

    el.addEventListener('loadeddata', () => {
      if (video.destroyed) return
      video.loaded = true
      el.style.opacity = '1'
      if (video.slots.length > 0) el.style.visibility = 'visible'
    }, { signal: abort.signal })

    el.src = gateways[0] ?? src
    // Append to document.body, NOT a React-rendered container. A
    // fixed-position container would create its own stacking context
    // and bound child z-indexes inside it — videos couldn't visually
    // sit above modals (z-50) or overlays.
    document.body.appendChild(el)

    return video
  }

  const value = useMemo<ContextValue>(
    () => ({
      acquire(src: string, slot: Slot) {
        let video = poolRef.current.get(src)
        if (!video) {
          video = createVideo(src)
          poolRef.current.set(src, video)
          evictIdleIfOverCap()
        }
        video.slots.unshift(slot)
        activateSlot(video, slot)
        return () => {
          if (!video) return
          const idx = video.slots.indexOf(slot)
          if (idx === -1) return
          const wasActive = idx === 0
          video.slots.splice(idx, 1)
          if (!wasActive) return
          const next = video.slots[0]
          if (next) {
            activateSlot(video, next)
            return
          }
          // No remaining slots. Hide the element immediately so a
          // route-change to a page that has no slot for this src
          // (e.g. /profile) doesn't leave the orphan video painting
          // over the new page for the grace window. Decoder +
          // currentTime stay alive in the pool; if a new slot mounts
          // within grace, activateSlot flips visibility back on
          // without re-creating the element.
          video.el.style.visibility = 'hidden'
          video.releaseTimer = window.setTimeout(() => {
            deactivate(video)
          }, RELEASE_GRACE_MS)
        }
      },
      refresh(src: string) {
        const video = poolRef.current.get(src)
        const active = video?.slots[0]
        if (video && active) positionElement(video, active)
      },
    }),
    // All helpers close over poolRef (stable across renders) — context
    // value never needs to change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    const pool = poolRef.current

    // One window-scroll/resize listener for the whole pool, fastdom
    // style: read every active slot's geometry in one pass, then apply
    // every video's styles. Interleaving reads and writes would force
    // a synchronous reflow per video per frame on WebKit. Per-slot
    // ancestor-scroll listeners stay in SharedVideoSlot since ancestor
    // sets vary per slot.
    let rafPending = false
    const flushAll = () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        const updates: Array<{
          video: ManagedVideo
          slot: Slot
          rect: DOMRect
          clip: DOMRect | null
        }> = []
        pool.forEach((video) => {
          const slot = video.slots[0]
          if (!slot) return
          const { rect, clip } = readSlotGeometry(slot)
          updates.push({ video, slot, rect, clip })
        })
        for (const { video, slot, rect, clip } of updates) {
          applySlotGeometry(video, slot, rect, clip)
        }
      })
    }
    window.addEventListener('scroll', flushAll, { passive: true })
    window.addEventListener('resize', flushAll)

    const interval = window.setInterval(() => {
      const now = Date.now()
      pool.forEach((video, src) => {
        if (video.slots.length === 0 && now - video.lastActiveAt > IDLE_EVICT_MS) {
          destroyVideo(video)
          pool.delete(src)
        }
      })
    }, 60_000)
    return () => {
      window.removeEventListener('scroll', flushAll)
      window.removeEventListener('resize', flushAll)
      clearInterval(interval)
      // Defensive: destroy all videos on provider unmount so they
      // don't outlive the React tree as orphan DOM nodes.
      pool.forEach((video) => destroyVideo(video))
      pool.clear()
    }
  }, [])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
