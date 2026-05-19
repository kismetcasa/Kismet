'use client'

import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { SharedVideoZIndexProvider } from '@/providers/SharedVideoProvider'

// Stacking invariant: BACKDROP < VIDEO < CHROME. Live in document.body's
// stacking context so each comparison holds without nesting. Constants
// rather than literals so the invariant is obvious in one place — an
// off-by-one and the X disappears behind the video.
const Z_BACKDROP = 50
const Z_VIDEO = 55
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
 */
export function ModalOverlay({ children }: { children: ReactNode }) {
  const router = useRouter()
  const dismiss = () => router.back()

  useEscapeKey(dismiss)
  useBodyScrollLock()

  // Defensive: ensure the modal scrolls into view on mount. Without
  // this, opening the modal from a scrolled-down feed could leave the
  // user looking at the same scroll position with the modal off-screen.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [])

  return (
    <>
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
          <SharedVideoZIndexProvider zIndex={Z_VIDEO}>
            {children}
          </SharedVideoZIndexProvider>
        </div>
      </div>
      {/* Close button rendered OUTSIDE the backdrop wrapper so it stacks
          in body, above the shared video element. Dark pill behind the
          X keeps it visible on bright media. */}
      <button
        onClick={dismiss}
        title="Close (Esc)"
        aria-label="Close"
        // backdrop-blur dropped (main also dropped this): same iOS
        // WebKit GPU-jank issue SearchModal had. Solid /70→/85 on
        // hover is plenty visible over the underlying video.
        // min-w/h=44 enforces the iOS HIG touch target — the 18px X
        // inside p-2 alone gave a ~34×34 hit area that missed often.
        // transition-colors (not transition-all) per main's button
        // perf pass; active:scale-95 snaps synchronously without a
        // transform transition, which is the right press feedback.
        className="fixed top-4 right-4 min-w-[44px] min-h-[44px] flex items-center justify-center text-[#bbb] hover:text-white bg-black/70 hover:bg-black/85 transition-colors active:scale-95 rounded-full"
        style={{ zIndex: Z_CHROME }}
      >
        <X size={18} />
      </button>
    </>
  )
}
