'use client'

import { useRouter, usePathname } from 'next/navigation'
import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFocusTrap } from '@/hooks/useFocusTrap'

// Stacking invariant: BACKDROP < CHROME. The detail video is now an inline
// element inside the backdrop's content, so it stacks naturally above the
// backdrop and below the close chrome without a dedicated z-index.
const Z_BACKDROP = 50
const Z_CHROME = 60

/**
 * Backdrop + close affordance + scroll container for the intercepted
 * detail-page route. The route handler wraps <MomentDetailView> in
 * <ModalOverlay> when the user navigates from inside the app, so
 * the detail page renders as an overlay over the still-mounted feed.
 * Direct URL loads bypass the interception and render the canonical
 * detail page without this wrapper.
 *
 * Dismiss paths (all call router.back() so the URL reverts to the feed
 * and Next.js unmounts the modal slot cleanly): backdrop click, Escape
 * key, X button.
 *
 * Auto-dismiss on forward nav: when the user clicks an internal Link
 * inside the overlay (artist profile, collection chip, comment author,
 * back-to-home), Next.js does not always resolve the @modal parallel
 * slot back to its default.tsx — the slot's render tree persists
 * across soft nav. We snap the pathname on mount and bail to null
 * once it drifts off, so the destination page renders cleanly without
 * a stale overlay layered on top.
 */
export function ModalOverlay({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const openedAt = useRef(pathname)
  const stale = pathname !== openedAt.current
  const dismiss = () => router.back()

  useEscapeKey(dismiss, !stale)
  useBodyScrollLock(!stale)
  // Keyboard focus must not wander into the still-mounted feed behind the
  // overlay. The trap wraps BOTH the dialog and the close button (siblings
  // for stacking reasons) via a display:contents wrapper, so Tab cycles
  // through the overlay's links, actions, and the X — and focus returns to
  // the opening card on dismiss.
  const trapRef = useRef<HTMLDivElement>(null)
  useFocusTrap(trapRef, !stale)

  // Defensive: ensure the modal scrolls into view on mount. Without
  // this, opening the modal from a scrolled-down feed could leave the
  // user looking at the same scroll position with the modal off-screen.
  useEffect(() => {
    if (stale) return
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [stale])

  if (stale) return null

  return (
    <div ref={trapRef} style={{ display: 'contents' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Moment detail"
        className="fixed inset-0 overflow-y-auto bg-black/90"
        style={{ zIndex: Z_BACKDROP }}
        onClick={(e) => {
          if (e.target === e.currentTarget) dismiss()
        }}
      >
        {/* Inner scroll container also dismisses on click. Without this
            handler the side-gutters on wide screens (auto-margins of the
            child's max-w wrapper) and the empty space below short content
            only land on this div — not on the outer backdrop — and the
            outer handler's target-equals-currentTarget check would skip
            them. Same dismiss path as the X / Escape / backdrop click,
            so the four feel interchangeable. */}
        <div
          className="min-h-full"
          onClick={(e) => {
            if (e.target === e.currentTarget) dismiss()
          }}
        >
          {children}
        </div>
      </div>
      {/* Close button rendered OUTSIDE the backdrop wrapper so it stacks
          in body, above the shared video element. No background pill —
          just the bare X — so the close affordance reads lighter and
          doesn't crowd the media on mobile / Mini App. */}
      <button
        onClick={dismiss}
        title="Close (Esc)"
        aria-label="Close"
        // min-w/h=44 keeps the iOS HIG touch target — the 18px X alone
        // gave a ~34×34 hit area that missed often. The hit area stays
        // 44×44 even though the visible glyph is now bare, so dropping
        // the pill doesn't shrink the tap target.
        // The dark bg-black pill was removed (felt invasive over the
        // media); a tight drop-shadow replaces it as the legibility
        // floor so the light glyph still reads over bright content
        // where a flat icon would wash out.
        // transition-colors (not transition-all) per main's button
        // perf pass; active:scale-95 snaps synchronously without a
        // transform transition, which is the right press feedback.
        className="fixed top-4 right-4 min-w-[44px] min-h-[44px] flex items-center justify-center text-[#bbb] hover:text-white transition-colors active:scale-95 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
        style={{ zIndex: Z_CHROME }}
      >
        <X size={18} />
      </button>
    </div>
  )
}
