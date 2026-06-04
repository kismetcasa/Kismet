'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { videoGatewayUrls } from '@/lib/media/gateway'
import { getVideoDuration } from '@/lib/media/durationCache'
import { acquireCommitted, committedActive } from '@/lib/media/videoFocus'
import { registerFeedVideo, type FeedVideoSlot } from '@/lib/media/feedPlayback'
import { LRUCache } from '@/lib/lruCache'

// Duration past which a video is treated as long-form: preload its body and
// don't loop (so the resume position survives), matching the old pool.
const LONG_FORM_DURATION_THRESHOLD_S = 60

// Resume position by canonical src, session-scoped. Updated on timeupdate so a
// detail opened over a still-playing card picks up where the card is, and so
// the value survives the card unmounting (LazyMount recycling). The old pool
// got this for free by keeping one element; with separate inline elements we
// carry just the timestamp.
const currentTimeMemory = new LRUCache<string, number>(256)

interface InlineVideoProps {
  /** Canonical video URI (ar://, ipfs://, https://). */
  src: string
  /** Committed viewing (detail): native controls, plays on mount, never
   *  auto-paused off-screen, and quiets the feed behind it. Feed cards
   *  leave this false. */
  controls?: boolean
  className?: string
  /** Fired once every gateway has errored — parent falls back to poster. */
  onError?: () => void
}

/**
 * Inline <video> for a moment. Replaces the position:fixed shared-pool element
 * — the video now lives in the card's own DOM, so the browser lays it out. No
 * JS transform tracking means it cannot park over the wrong card or smear on
 * iOS momentum scroll (the bug class the pool kept reintroducing), and the
 * per-card acquire/append/getBoundingClientRect work on mount disappears.
 *
 * Behaviour carried over from the pool:
 *   - autoplay muted loop inline for short clips; preload=auto + no loop for
 *     long-form (seeded from the duration cache, no metadata round-trip)
 *   - play on-screen / pause off-screen for feed cards (bounds active
 *     decoders); committed videos play on mount and aren't auto-paused
 *   - gateway fallback walk on a <video> error
 *   - currentTime resume across surfaces
 *   - feed quiets while a committed (detail) video is open (videoFocus)
 */
export function InlineVideo({ src, controls = false, className, onError }: InlineVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const gateways = useMemo(() => videoGatewayUrls(src), [src])
  const [gatewayIndex, setGatewayIndex] = useState(0)
  const [loaded, setLoaded] = useState(false)

  const isLongForm = useMemo(() => {
    const d = getVideoDuration(src)
    return typeof d === 'number' && d > LONG_FORM_DURATION_THRESHOLD_S
  }, [src])

  // One-shot guard for the detail's auto-unmute (below) so a deliberate
  // manual mute via the native controls isn't overridden on a later event.
  const unmuteTriedRef = useRef(false)

  // Reset the gateway walk + fade when the src changes.
  useEffect(() => {
    setGatewayIndex(0)
    setLoaded(false)
    unmuteTriedRef.current = false
  }, [src])

  // Feed playback is governed centrally by lib/media/feedPlayback: one
  // coordinator ranks every mounted feed video by distance to the viewport
  // centre and grants at most MAX_CONCURRENT_PLAY "play" slots (capped for the
  // iOS decoder budget) plus a slightly larger "buffer" window. `slotRef`
  // mirrors the latest grant for the event handlers; `buffering` drives the
  // preload attribute and only flips when the buffer window changes (rare),
  // so the extra render is negligible. Committed (detail) videos bypass all
  // of this and always play.
  const slotRef = useRef<FeedVideoSlot>({ play: false, buffer: false })
  const [buffering, setBuffering] = useState(false)

  const tryPlay = () => {
    const el = ref.current
    if (!el) return
    if (controls) {
      // Detail = committed viewing: try to play WITH sound. Clicking through a
      // card is a user gesture and Next.js soft-nav keeps the same document,
      // so the browser usually allows the unmute; if it doesn't (a slow load
      // outran the activation window, or this is a direct URL load with no
      // preceding gesture) we fall back to muted and the user can unmute via
      // the native controls. Unmuting a silent clip is a no-op, so there's no
      // need to probe for an audio track first. Done once so a manual mute
      // isn't undone by a later canplay/seek.
      if (!unmuteTriedRef.current) {
        unmuteTriedRef.current = true
        el.muted = false
        el.play().catch(() => {
          el.muted = true
          el.play().catch(() => {})
        })
        return
      }
      el.play().catch(() => {})
      return
    }
    if (slotRef.current.play && !committedActive()) el.play().catch(() => {})
    else el.pause()
  }

  useEffect(() => {
    // Committed (detail) videos: claim focus so the feed quiets behind them,
    // and skip the feed coordinator — they own the viewport while open and
    // always play.
    if (controls) return acquireCommitted()

    const el = ref.current
    if (!el) return

    // Register with the central feed coordinator. It calls back with this
    // card's current {play, buffer} grant whenever the ranking changes
    // (scroll start/stop, a sibling mounting/unmounting, a detail video
    // opening). We translate that into preload (buffer) + play/pause (play).
    // Nothing here moves the element, so it can't reintroduce the old
    // fixed-overlay positioning bug — only decode/buffer state changes.
    const reg = registerFeedVideo((slot) => {
      slotRef.current = slot
      setBuffering(slot.buffer)
      tryPlay()
    })

    // One IntersectionObserver reports this card's distance to the viewport
    // centre + whether it's actually on screen. rootMargin '100%' = "within
    // one viewport above/below", so cards are reported (and warmed) before
    // they scroll in. The rects come from the entry the browser already
    // computed — no main-thread getBoundingClientRect, no layout thrash.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const rb = entry.rootBounds
        const viewportCentre = rb
          ? (rb.top + rb.bottom) / 2
          : typeof window !== 'undefined'
            ? window.innerHeight / 2
            : 0
        const br = entry.boundingClientRect
        const distance = Math.abs((br.top + br.bottom) / 2 - viewportCentre)
        reg.update(distance, entry.isIntersecting)
      },
      { threshold: [0, 0.5, 1], rootMargin: '100% 0px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      reg.release()
    }
    // tryPlay is intentionally omitted — it only reads refs, and adding it
    // would re-run this effect every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, src])

  // Persist position on unmount (covers a card recycled by LazyMount before a
  // timeupdate fires). The element is stable for this src (keyed on it), so
  // capturing it at effect time and reading currentTime in cleanup yields the
  // final position.
  useEffect(() => {
    const el = ref.current
    return () => {
      if (el && Number.isFinite(el.currentTime) && el.currentTime > 0) {
        currentTimeMemory.set(src, el.currentTime)
      }
    }
  }, [src])

  function handleError() {
    setGatewayIndex((i) => {
      const next = i + 1
      if (next >= gateways.length) {
        onErrorRef.current?.()
        return i
      }
      return next
    })
  }

  function handleLoadedMetadata() {
    const el = ref.current
    if (!el) return
    const saved = currentTimeMemory.get(src)
    if (
      saved !== undefined &&
      saved > 0 &&
      Number.isFinite(el.duration) &&
      saved < el.duration - 0.5
    ) {
      try {
        el.currentTime = saved
      } catch {
        /* seek can throw before the element is seekable; ignore */
      }
    }
  }

  function handleTimeUpdate() {
    const el = ref.current
    if (el && Number.isFinite(el.currentTime) && el.currentTime > 0) {
      currentTimeMemory.set(src, el.currentTime)
    }
  }

  return (
    <video
      ref={ref}
      key={src}
      src={gateways[gatewayIndex] ?? src}
      className={className}
      muted
      loop={!isLongForm}
      playsInline
      controls={controls}
      preload={controls || buffering ? 'auto' : 'metadata'}
      // Fade in over the poster/thumbhash layer once the first frame is ready.
      style={{ opacity: loaded ? 1 : 0, transition: 'opacity 0.2s ease' }}
      onError={handleError}
      onLoadedMetadata={handleLoadedMetadata}
      onLoadedData={() => setLoaded(true)}
      onCanPlay={tryPlay}
      onTimeUpdate={handleTimeUpdate}
    />
  )
}
