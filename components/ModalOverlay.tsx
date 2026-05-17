'use client'

import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { SharedVideoZIndexProvider } from '@/providers/SharedVideoProvider'

/**
 * Backdrop + close affordance + scroll container for the intercepted
 * detail-page route. The route handler wraps <MomentDetailView> in
 * <ModalOverlay> when the user navigates from inside the app, so
 * the detail page renders as an overlay over the still-mounted feed.
 * Direct URL loads bypass the interception and render the canonical
 * detail page without this wrapper.
 *
 * Dismiss paths (all call router.back() so the URL reverts to the
 * feed and Next.js unmounts the modal slot cleanly):
 *   - Click the backdrop outside the modal content
 *   - Press Escape
 *   - Click the X button
 *
 * Z-index layering (in document.body's stacking context):
 *   - Backdrop:         z-50
 *   - Shared video el:  z-55 (set via SharedVideoZIndexProvider so any
 *                       <SharedVideoSlot> nested under us stacks
 *                       above the backdrop)
 *   - Close button:     z-60 (above the video, since the video is
 *                       pointer-events: auto when in controls mode
 *                       and would otherwise intercept the close click)
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
        className="fixed inset-0 overflow-y-auto bg-black/85 backdrop-blur-sm"
        style={{ zIndex: 50 }}
        onClick={(e) => {
          // Only dismiss when the click hit the backdrop itself, not
          // bubbled from inner content.
          if (e.target === e.currentTarget) dismiss()
        }}
      >
        <div className="min-h-full">
          <SharedVideoZIndexProvider zIndex={55}>
            {children}
          </SharedVideoZIndexProvider>
        </div>
      </div>
      {/* Close button rendered OUTSIDE the backdrop wrapper. Inside,
          its z-index would be bounded by the backdrop's stacking
          context; out here, it stacks at its own z-60 in body, which
          is above any shared video element (z-55). */}
      {/* Subtle dark pill behind the X keeps it visible on bright media
          (otherwise text-[#888] disappears into a white poster). The
          backdrop-blur softens the underlying image without a hard
          opaque chip. */}
      <button
        onClick={dismiss}
        title="Close (Esc)"
        aria-label="Close"
        className="fixed top-4 right-4 p-2 text-[#bbb] hover:text-white bg-black/50 backdrop-blur-sm hover:bg-black/70 transition-colors rounded-full"
        style={{ zIndex: 60 }}
      >
        <X size={18} />
      </button>
    </>
  )
}
