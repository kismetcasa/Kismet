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

// ─── Z-index override context ───────────────────────────────────────
// Overlay surfaces (intercepting-route modals, lightbox) wrap their
// children in <SharedVideoZIndexProvider> to override the z-index any
// nested <SharedVideoSlot> uses for its video element — so the video
// stacks above the overlay's backdrop instead of being hidden behind it.
// Defaults to undefined: slot uses its own zIndex prop or the default.

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
  /** Z-index for the video element while this slot is active. */
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
  observer: IntersectionObserver | null
  gateways: string[]
  gatewayIndex: number
  src: string
  loaded: boolean
  lastActiveAt: number
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
    el.style.top = `${rect.top}px`
    el.style.left = `${rect.left}px`
    el.style.width = `${rect.width}px`
    el.style.height = `${rect.height}px`
    el.style.zIndex = String(slot.zIndex)
    el.style.pointerEvents = slot.controls ? 'auto' : 'none'
    el.controls = slot.controls
    // preload="auto" on committed-viewing surfaces (detail page, lightbox)
    // so the browser buffers aggressively; "metadata" on previews so a
    // grid of cards doesn't saturate bandwidth simultaneously. Hint
    // only — browsers may ignore changes after initial load — but
    // matches caller intent in case the element is later replaced.
    el.preload = slot.controls ? 'auto' : 'metadata'
    if (video.loaded) el.style.visibility = 'visible'
  }

  function activateSlot(video: ManagedVideo, slot: Slot) {
    if (video.releaseTimer !== null) {
      clearTimeout(video.releaseTimer)
      video.releaseTimer = null
    }
    video.lastActiveAt = Date.now()
    positionElement(video, slot)

    // Replace any prior IntersectionObserver. Controlled surfaces
    // (detail page, lightbox) skip IO — the user owns play/pause there.
    // Otherwise pause when off-screen.
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
    video.observer?.disconnect()
    if (video.releaseTimer !== null) clearTimeout(video.releaseTimer)
    video.el.pause()
    video.el.removeAttribute('src')
    video.el.load()
    video.el.remove()
  }

  function evictIdleIfOverCap() {
    if (poolRef.current.size <= MAX_POOL_SIZE) return
    // Collect candidates first, then sort — avoids TypeScript narrowing
    // issues with closure-captured `let` variables inside forEach.
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
    el.style.transition =
      'top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease'

    const video: ManagedVideo = {
      el,
      slots: [],
      releaseTimer: null,
      observer: null,
      gateways,
      gatewayIndex: 0,
      src,
      loaded: false,
      lastActiveAt: Date.now(),
    }

    // Gateway walking. On error, try the next gateway. When the pool
    // is exhausted, notify every registered slot's onError so each
    // caller can drop the slot and show the poster fallback.
    el.addEventListener('error', () => {
      const next = video.gatewayIndex + 1
      if (next < video.gateways.length) {
        video.gatewayIndex = next
        el.src = video.gateways[next]!
      } else {
        video.slots.forEach((s) => s.onError?.())
      }
    })

    // First-frame paint: reveal the element. Same element persists
    // across surfaces, so this fires once per src.
    el.addEventListener('loadeddata', () => {
      video.loaded = true
      el.style.opacity = '1'
      if (video.slots.length > 0) el.style.visibility = 'visible'
    })

    el.src = gateways[0] ?? src
    // Append to document.body, NOT a React-rendered container. A
    // fixed-position container would create its own stacking context
    // and bound child z-indexes inside it — videos couldn't visually
    // sit above modals (z-50) or overlays. Living directly in body,
    // each video's z-index applies in body's stacking context.
    document.body.appendChild(el)

    return video
  }

  // Stable function identities — the pool state lives in poolRef.current,
  // so the context value never needs to change across renders.
  const value = useMemo<ContextValue>(
    () => ({
      acquire(src: string, slot: Slot) {
        let video = poolRef.current.get(src)
        if (!video) {
          video = createVideo(src)
          poolRef.current.set(src, video)
          evictIdleIfOverCap()
        }
        // Push to the front of the slots list — this slot is now
        // most-recent and becomes the active one.
        video.slots.unshift(slot)
        activateSlot(video, slot)
        return () => {
          if (!video) return
          const idx = video.slots.indexOf(slot)
          if (idx === -1) return
          const wasActive = idx === 0
          video.slots.splice(idx, 1)
          if (!wasActive) return
          // Active slot released. If there's another registered slot
          // (e.g. card slot still mounted while overlay slot just
          // released), fall back to it immediately — no grace timer
          // needed because we have somewhere to go.
          const next = video.slots[0]
          if (next) {
            activateSlot(video, next)
            return
          }
          // No remaining slots — start the grace timer. If a new slot
          // for this src mounts within the grace window (typical
          // route-transition pattern), it'll cancel the timer and
          // reuse the element.
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
    // All helper functions close over refs (stable across renders) — no
    // need to re-create the context value when the component re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // Periodic eviction of idle entries past the TTL. Also runs full
  // destroy on provider unmount (cleanup) so we don't leak video
  // elements in document.body if the provider is ever swapped out.
  useEffect(() => {
    // Capture the Map identity at effect time. poolRef.current never
    // gets reassigned (it's set once via useRef's initial value), so
    // this is the same Map at cleanup time — satisfying the lint rule
    // without changing behaviour.
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
      // Defensive: if the provider unmounts (shouldn't happen in
      // normal use since it's in the root layout), destroy all videos
      // so they don't outlive the React tree as orphan DOM nodes.
      pool.forEach((video) => destroyVideo(video))
      pool.clear()
    }
  }, [])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
