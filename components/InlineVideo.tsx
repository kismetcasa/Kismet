'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { videoGatewayUrls } from '@/lib/media/gateway'
import { getVideoDuration } from '@/lib/media/durationCache'
import { acquireCommitted, committedActive } from '@/lib/media/videoFocus'
import { registerFeedVideo, type FeedVideoSlot } from '@/lib/media/feedPlayback'
import { LRUCache } from '@/lib/lruCache'

// Duration past which a video is treated as long-form: don't loop, so the
// resume position survives a re-open. Seeded from the duration cache so the
// decision is known at element-create time with no metadata round-trip.
// (Preload is driven by the feed buffer window — see lib/media/feedPlayback —
// not by this flag.)
const LONG_FORM_DURATION_THRESHOLD_S = 60

// How long a feed video may sit OUTSIDE the loaded window before its media
// element is released — dropping the source + load() to free the iOS decoder,
// which pausing alone does NOT do. The delay is scroll hysteresis: a card that
// briefly dips out of the window mid-scroll isn't torn down. A detail video
// opening releases the feed immediately instead (it needs the budget now).
const RELEASE_DELAY_MS = 500

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
 * Behaviour:
 *   - muted inline playback; short clips loop, long-form doesn't (so the
 *     resume position survives), seeded from the duration cache with no
 *     metadata round-trip
 *   - feed playback is governed centrally by lib/media/feedPlayback: only the
 *     nearest on-screen cards play (capped for the iOS decoder budget) and they
 *     keep playing through a scroll, pausing only when they leave view, while a
 *     buffer-ahead window warms upcoming videos (preload=auto) so landing on one
 *     is instant. Committed (detail) videos bypass the coordinator and play on
 *     mount.
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
  // Released = media element unloaded to free its decoder. On iOS, pausing a
  // <video> does NOT free the decoder — only unloading does — so a feed of
  // paused-but-loaded videos exhausts the device's media-element budget and
  // new / scrolled-back / detail videos then stall. Far feed videos release;
  // the near (loaded-window) ones stay alive for instant resume.
  const [released, setReleased] = useState(false)

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
    // (a card moving in/out of view, a sibling mounting/unmounting, a detail
    // video opening). We translate that into preload (buffer) + play/pause.
    // Nothing here moves the element, so it can't reintroduce the old
    // fixed-overlay positioning bug — only decode/buffer state changes.
    const reg = registerFeedVideo((slot) => {
      slotRef.current = slot
      setBuffering(slot.buffer)
      tryPlay()
    })

    // One IntersectionObserver reports this card's distance to the viewport
    // centre + whether it actually overlaps the viewport. rootMargin '100%' =
    // "within one viewport above/below", so approaching cards are reported (and
    // warmed) before they scroll in, while PLAY gates on true-viewport overlap
    // (computed from the rect below) so a just-off-screen card never wins a
    // decode slot. The rects come from the entry the browser already computed —
    // no main-thread getBoundingClientRect, no layout thrash.
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        const br = entry.boundingClientRect
        // True viewport height (NOT the rootMargin-expanded root): the
        // boundingClientRect is viewport-relative, so top=0 is the viewport top.
        const vpH =
          typeof window !== 'undefined' && window.innerHeight
            ? window.innerHeight
            : entry.rootBounds?.height ?? 0
        const distance = Math.abs((br.top + br.bottom) / 2 - vpH / 2)
        const visible = br.bottom > 0 && br.top < vpH
        reg.update(distance, visible)
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: '100% 0px' },
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

  // Release / restore the media element to bound the device's decoder budget.
  // When a feed video falls out of the loaded window (buffer=false), free its
  // decoder after a short hysteresis delay — immediately if a detail video is
  // waiting for budget. When it re-enters the window the source is restored and
  // it reloads (warm from cache) + seeks to the saved position. Committed
  // (detail) videos never release.
  useEffect(() => {
    if (controls) return
    if (buffering) {
      setReleased(false)
      return
    }
    const t = setTimeout(
      () => setReleased(true),
      committedActive() ? 0 : RELEASE_DELAY_MS,
    )
    return () => clearTimeout(t)
  }, [buffering, controls])

  // Free the decoder once released: preserve the position, then load() to abort
  // the resource (the render has already cleared the src attribute). The poster
  // / thumbhash layer behind the video carries the visual while it's unloaded.
  useEffect(() => {
    const el = ref.current
    if (!el || !released) return
    if (Number.isFinite(el.currentTime) && el.currentTime > 0) {
      currentTimeMemory.set(src, el.currentTime)
    }
    try {
      el.removeAttribute('src')
      el.load()
    } catch {
      /* load can throw mid-state; ignore */
    }
    setLoaded(false)
  }, [released, src])

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
      // Detail (controls) videos append #t=0.001 so iOS paints the first frame
      // during load — iOS never preloads otherwise, so the slot shows a black
      // box until playback starts (worst for poster-less / thumbhash-less
      // moments). Feed videos omit it (their poster layer covers them) to avoid
      // forcing frame loads that fight the decoder budget.
      src={released ? undefined : (gateways[gatewayIndex] ?? src) + (controls ? '#t=0.001' : '')}
      className={className}
      muted
      loop={!isLongForm}
      playsInline
      controls={controls}
      preload={controls || buffering ? 'auto' : 'none'}
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
