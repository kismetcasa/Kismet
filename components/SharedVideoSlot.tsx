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
 * On mount: registers a slot with the pool. On unmount: releases (the
 * pool starts a 1-second grace timer so route transitions don't destroy
 * the element). ResizeObserver + window scroll/resize listeners keep
 * the video positioned correctly as the slot's bounds change — coalesced
 * via rAF since `scroll` fires per-pixel on most browsers.
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

    const release = ctx.acquire(src, {
      ref: el,
      controls,
      zIndex: finalZIndex,
      onError: () => onErrorRef.current?.(),
      clipAncestors,
    })

    // rAF-coalesce repositioning. The window scroll/resize path is
    // centralised in SharedVideoProvider (one listener batches every
    // active video in a fastdom read-then-write pass); slots only own
    // their per-element refresh triggers — ResizeObserver for slot
    // size changes, and scroll listeners on each clipping ancestor
    // (which the provider doesn't know about, since ancestor sets vary
    // per slot).
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
  }, [ctx, src, controls, finalZIndex])

  return <div ref={ref} className={className} aria-hidden />
}
