'use client'

import { useEffect, useRef, useState } from 'react'
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
 * On mount: registers a slot with the pool (which creates the underlying
 * <video> element if no entry exists for the src yet, or reuses the
 * already-pooled one). On unmount: releases. The pool's 1s grace timer
 * keeps an element alive across route transitions long enough for the
 * next surface to re-claim it without re-decoding.
 *
 * Per-slot we attach a ResizeObserver (for slot size changes) and scroll
 * listeners on each clipping ancestor — those aren't covered by the
 * provider's centralised window-scroll handler since ancestor sets are
 * slot-specific.
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
  // Re-acquire token: bumped by the pool's onEvicted callback when the
  // safety-net eviction (provider's evictIdleIfOverCap stale tier)
  // destroys this slot's video. The acquire effect's dep on this token
  // re-fires the effect → fresh acquire against a new pool entry.
  const [acquireToken, setAcquireToken] = useState(0)

  // Keep latest onError in a ref so the acquire effect doesn't re-run
  // on every parent render. Direct write during render is the standard
  // ref-on-render pattern — refs aren't reactive so this is safe.
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // Same ref-pattern for controls + zIndex: in practice they don't
  // toggle for a given React component instance (a feed card is
  // always controls=false, a detail-view slot is always
  // controls=true), but a parent re-render that recreates the prop
  // identity would otherwise re-trigger the entire acquire/release
  // cycle, racing with the new tab's mount on tab swaps and leaving
  // the pool's `video.slots[0]` pointing at a stale unmounted ref —
  // which is what produced the "video overlays in wrong place" bug
  // when bouncing between discover sub-tabs.
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  const finalZIndex = zIndex ?? overrideZIndex ?? DEFAULT_Z_INDEX
  const finalZIndexRef = useRef(finalZIndex)
  finalZIndexRef.current = finalZIndex

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

    const release = ctx.acquire(src, {
      ref: el,
      controls: controlsRef.current,
      zIndex: finalZIndexRef.current,
      onError: () => onErrorRef.current?.(),
      onEvicted: () => setAcquireToken((t) => t + 1),
      clipAncestors,
    })

    let rafPending = false
    const scheduleRefresh = () => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        ctx.refresh(src)
      })
    }
    const ro = new ResizeObserver(scheduleRefresh)
    ro.observe(el)
    for (const a of clipAncestors) {
      a.addEventListener('scroll', scheduleRefresh, { passive: true })
    }

    return () => {
      release()
      ro.disconnect()
      for (const a of clipAncestors) {
        a.removeEventListener('scroll', scheduleRefresh)
      }
    }
    // Deps: slot lifecycle identity (ctx + src) plus acquireToken so the
    // pool's onEvicted forces a re-acquire. controls/zIndex use the
    // ref-on-render pattern above (see comment).
  }, [ctx, src, acquireToken])

  return <div ref={ref} className={className} aria-hidden />
}
