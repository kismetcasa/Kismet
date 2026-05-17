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

// Hard cap on pool size. Past this, idle entries get evicted on next acquire.
const MAX_POOL_SIZE = 10

// ─── Provider ────────────────────────────────────────────────────────

export function SharedVideoProvider({ children }: { children: ReactNode }) {
  const poolRef = useRef<Map<string, ManagedVideo>>(new Map())

  function positionElement(video: ManagedVideo, slot: Slot) {
    const rect = slot.ref.getBoundingClientRect()
    const el = video.el
    if (
      rect.top !== video.lastTop ||
      rect.left !== video.lastLeft ||
      rect.width !== video.lastWidth ||
      rect.height !== video.lastHeight
    ) {
      el.style.top = `${rect.top}px`
      el.style.left = `${rect.left}px`
      el.style.width = `${rect.width}px`
      el.style.height = `${rect.height}px`
      video.lastTop = rect.top
      video.lastLeft = rect.left
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
    if (video.loaded) el.style.visibility = 'visible'
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
        'top 0.18s ease, left 0.18s ease, width 0.18s ease, height 0.18s ease'
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
        { threshold: 0.01, rootMargin: '200px' },
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
      clearInterval(interval)
      // Defensive: destroy all videos on provider unmount so they
      // don't outlive the React tree as orphan DOM nodes.
      pool.forEach((video) => destroyVideo(video))
      pool.clear()
    }
  }, [])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
