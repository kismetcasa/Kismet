'use client'

import { useEffect, useState, type RefObject } from 'react'

/**
 * True once `ref` has stayed within `rootMargin` of the viewport continuously
 * for `dwellMs`, and false again the moment it leaves. A fast fly-by (in and
 * out before the dwell elapses) never flips true, so callers gating data
 * fetches on it skip the cards a user scrolls straight past — the lever that
 * keeps a fast scroll from triggering a per-card fetch/RPC storm.
 *
 * Dwell is a plain timer rather than IntersectionObserver v2's
 * trackVisibility/`delay` because that flag is Chromium-only — absent in the
 * iOS WebKit that is this app's primary surface.
 */
export function useInViewDwell<T extends Element>(
  ref: RefObject<T | null>,
  { rootMargin = '200px', dwellMs = 150 }: { rootMargin?: string; dwellMs?: number } = {},
): boolean {
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const io = new IntersectionObserver(
      ([entry]) => {
        // Clear any pending dwell on every callback first. The observer can
        // deliver consecutive intersecting callbacks without an intervening
        // exit (re-observe of an already-visible element, a WebKit redelivery,
        // or a layout shift while still intersecting). Without this, a leaked
        // timer could fire setInView(true) after the card has already left view
        // and its exit already ran — sticking `inView` true off-screen and
        // defeating the fast-scroll gate this hook exists to provide.
        clearTimeout(timer)
        if (entry?.isIntersecting) {
          // Arm the dwell — only a card that stays in view this long fetches.
          timer = setTimeout(() => setInView(true), dwellMs)
        } else {
          setInView(false)
        }
      },
      { rootMargin },
    )
    io.observe(el)
    return () => {
      clearTimeout(timer)
      io.disconnect()
    }
  }, [ref, rootMargin, dwellMs])

  return inView
}
