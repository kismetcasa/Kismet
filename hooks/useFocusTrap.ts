'use client'

import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keep keyboard/screen-reader focus inside a modal container while it's
 * mounted, and restore focus to the opener on close. Dependency-free
 * (matching the repo's no-new-deps posture): Tab/Shift+Tab cycle within the
 * container's tabbables; everything else is untouched. Pair with
 * role="dialog" aria-modal="true" on the container.
 *
 * Initial focus: if something inside the container is already focused (e.g.
 * SearchModal autofocuses its input), it is left alone; otherwise the first
 * tabbable (or the container itself — give it tabIndex={-1}) gets focus.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean = true) {
  useEffect(() => {
    if (!active) return
    const container = ref.current
    if (!container) return

    const opener = document.activeElement as HTMLElement | null

    const tabbables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
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
      // otherwise land at the document top after every close.
      opener?.focus?.()
    }
  }, [ref, active])
}
