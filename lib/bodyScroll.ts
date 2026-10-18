/**
 * A reference-counted body scroll lock, for full-screen layers that stack:
 * a zine's opening frame hands off to the reader while both are mounted
 * (components/ZineOpening, components/ZineReader).
 *
 * Two layers that each "restore what they found" break on that handoff —
 * whichever unmounts second puts back the other's `hidden`, and the page
 * stays locked after the reader closes, or scrolls under a reader still
 * open. Counting holds makes the order irrelevant: the first hold saves the
 * overflow it finds (the in-app overlay route may already hold its own lock,
 * and must get `hidden` back), the last release restores exactly that.
 */
let holds = 0
let saved = ''

/** Lock body scroll; returns the release (idempotent). */
export function holdBodyScroll(): () => void {
  if (holds++ === 0) {
    saved = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--holds === 0) document.body.style.overflow = saved
  }
}
