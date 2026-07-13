'use client'

import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface FocusTrapOptions {
  /** Consulted at deactivation. Return false to skip restoring focus to the
   *  opener — e.g. ModalOverlay's forward-nav path, where the user is
   *  navigating AWAY and yanking focus back to the (background) feed card
   *  would fight the destination page. Default: always restore. */
  shouldRestore?: () => boolean
}

/**
 * Keep keyboard/screen-reader focus inside a modal container while it's
 * mounted, and restore focus to the opener on close. Dependency-free
 * (matching the repo's no-new-deps posture): Tab/Shift+Tab cycle within the
 * container's tabbables; everything else is untouched. Pair with
 * role="dialog" aria-modal="true" on the container.
 *
 * Visibility predicate: `getClientRects().length > 0` — the standard check
 * (what focus-trap libraries use as their base test). NOT `offsetParent`,
 * which is null for position:fixed elements and silently excluded
 * ModalOverlay's fixed close button from the Tab cycle — the trap then
 * intercepted at the last in-flow element and wrapped PAST the X, making it
 * unreachable by keyboard.
 *
 * Initial focus: if something inside the container is already focused (e.g.
 * SearchModal autofocuses its input), it is left alone; otherwise the first
 * tabbable (or the container itself — give it tabIndex={-1}) gets focus.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean = true,
  options?: FocusTrapOptions,
) {
  const shouldRestore = options?.shouldRestore
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    const opener = document.activeElement as HTMLElement | null

    const tabbables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0 || el === document.activeElement,
      )

    if (!container.contains(document.activeElement)) {
      const first = tabbables()[0]
      ;(first ?? container).focus()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const els = tabbables()
      if (els.length === 0) {
        e.preventDefault()
        return
      }
      const first = els[0]
      const last = els[els.length - 1]
      const current = document.activeElement
      if (e.shiftKey && (current === first || !container.contains(current))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (current === last || !container.contains(current))) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      // Restore focus to whatever opened the modal — screen-reader users
      // otherwise land at the document top after every close. Skipped when
      // the caller says the deactivation is a forward NAVIGATION, not a
      // dismissal (restoring would steal focus from the destination page).
      if (shouldRestore && !shouldRestore()) return
      opener?.focus?.()
    }
  }, [ref, active, shouldRestore])
}
