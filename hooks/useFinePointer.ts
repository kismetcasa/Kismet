import { useEffect, useState } from 'react'

/**
 * True only on devices with a precise pointer (mouse / trackpad). Used
 * to gate drag-to-reorder UI — HTML5 `draggable` intercepts tap-and-
 * hold on touch screens and breaks tap handlers, so we keep drag a
 * desktop-only affordance.
 *
 * SSR-safe: returns `false` during render until the effect runs
 * client-side, so the SSR HTML is never marked draggable.
 */
export function useFinePointer(): boolean {
  const [isFine, setIsFine] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(pointer: fine)')
    setIsFine(mql.matches)
    // Some browsers fire change when a device docks/undocks a mouse;
    // we update so the user's experience tracks reality.
    const onChange = (e: MediaQueryListEvent) => setIsFine(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isFine
}
