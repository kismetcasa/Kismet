'use client'

import { useEffect, useRef } from 'react'
import {
  useSharedVideoContext,
  useSharedVideoZIndex,
  scrollableAncestors,
} from '@/providers/SharedVideoProvider'

interface Props {
  /** Canonical video URI (ar://, ipfs://, or https://). */
  src: string
  /** Show native controls + skip the off-screen pause behaviour. Detail
   *  page and lightbox set this to true. */
  controls?: boolean
  /** Z-index for the video element while this slot is active. Defaults
   *  to 10 (above page content). Can be overridden by a parent
   *  <SharedVideoZIndexProvider> (used by ModalOverlay to lift videos
   *  above the overlay's z-50 backdrop). */
  zIndex?: number
  /** Fires when every gateway has errored for this src. The parent
   *  drops the slot and falls back to poster-only rendering. */
  onError?: () => void
  /** Visual className applied to the placeholder div the pool positions
   *  the video element over. */
  className?: string
}

const DEFAULT_Z_INDEX = 10

/**
 * Anchor for the persistent shared video element. Renders an empty div
 * at the position/size the video should occupy; the SharedVideoProvider
 * CSS-positions a managed <video> element to overlay it.
 *
 * Acquire lifecycle:
 *   - controls=true (lightbox, detail page): acquire immediately on
 *     mount so the route-transition morph from card → overlay is
 *     instant. Releases on unmount; provider grace timer (1s) keeps
 *     the element alive long enough for the previous surface (e.g.
 *     the card we morphed from) to re-claim it without re-decoding.
 *   - controls=false (feed cards): lazy-acquire via IntersectionObserver
 *     with a 300px rootMargin. Without this, every card on the
 *     homepage triggered an immediate `<video>` element creation +
 *     Arweave HTTP request on mount; with 18 cards on page 1 that's
 *     18 simultaneous fetches, queued past Safari's 6-per-host
 *     connection cap and causing videos near the bottom of the page
 *     to spend seconds waiting in the HTTP queue before they could
 *     even start loading. Lazy-acquire keeps the network + decoder
 *     budget proportional to what's actually near the screen.
 *
 * On every acquire we attach a ResizeObserver (for slot size changes)
 * and scroll listeners on each clipping ancestor (their scroll events
 * aren't covered by the provider's centralised window-scroll handler,
 * since ancestor sets vary per slot). All of that gets torn down on
 * release so an off-screen slot has zero ongoing cost.
 */
export function SharedVideoSlot({
  src,
  controls = false,
  zIndex,
  onError,
  className,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const ctx = useSharedVideoContext()
  const overrideZIndex = useSharedVideoZIndex()

  // Keep latest onError in a ref so the acquire effect doesn't re-run
  // on every parent render. Direct write during render is the standard
  // ref-on-render pattern — refs aren't reactive so this is safe.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const finalZIndex = zIndex ?? overrideZIndex ?? DEFAULT_Z_INDEX

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Inner-scroller awareness. Window scroll alone misses any ancestor
    // with overflow:auto/scroll/hidden — the featured collection's
    // mobile horizontal mints row, for example. We need the slot to
    // re-position on those ancestors' scroll AND we need positionElement
    // to clip-path the video to their intersected bounds. Compute the
    // list once on mount and pass through to the pool so it doesn't
    // re-walk + re-getComputedStyle on every refresh tick.
    const clipAncestors = scrollableAncestors(el)

    let release: (() => void) | null = null
    let ro: ResizeObserver | null = null
    let rafPending = false

    const scheduleRefresh = () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        ctx.refresh(src)
      })
    }

    const doAcquire = () => {
      if (release) return
      release = ctx.acquire(src, {
        ref: el,
        controls,
        zIndex: finalZIndex,
        onError: () => onErrorRef.current?.(),
        clipAncestors,
      })
      ro = new ResizeObserver(scheduleRefresh)
      ro.observe(el)
      for (const a of clipAncestors) {
        a.addEventListener('scroll', scheduleRefresh, { passive: true })
      }
    }

    const doRelease = () => {
      if (!release) return
      release()
      release = null
      ro?.disconnect()
      ro = null
      for (const a of clipAncestors) {
        a.removeEventListener('scroll', scheduleRefresh)
      }
    }

    let acquireIo: IntersectionObserver | null = null
    if (controls) {
      doAcquire()
    } else {
      // 1500px (~2 screen heights) is wide enough that Chrome can
      // resume its eager pre-load behaviour — videos within ~2 screens
      // of viewport start fetching metadata, so by the time the user
      // scrolls to them the bytes are ready and play() is instant. At
      // 300px the prior margin was too aggressive: it cut Chrome's
      // pre-buffer to a thin sliver and introduced a perceptible
      // fetch+decode delay on cards approaching the fold. Still
      // bounded — pages a long way down the infinite-scroll feed
      // don't fetch until they're within ~2 screens.
      acquireIo = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) doAcquire()
          else doRelease()
        },
        { rootMargin: '1500px' },
      )
      acquireIo.observe(el)
    }

    return () => {
      acquireIo?.disconnect()
      doRelease()
    }
  }, [ctx, src, controls, finalZIndex])

  return <div ref={ref} className={className} aria-hidden />
}
