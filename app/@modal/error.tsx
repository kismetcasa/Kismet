'use client'

import { useEffect, startTransition } from 'react'
import { useRouter } from 'next/navigation'
import { reloadOnceForChunkError } from '@/lib/chunkReload'
import { useEscapeKey } from '@/hooks/useEscapeKey'

// Error boundary for the @modal parallel slot. Without it a throw in the
// overlay bubbles to app/error.tsx and — because {modal} renders after <main>
// in the layout — paints at the bottom of the still-mounted feed. Scoping the
// boundary here contains the failure to a dismissible overlay instead.
export default function ModalMomentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()
  const dismiss = () => router.back()
  useEscapeKey(dismiss)

  useEffect(() => {
    // ChunkLoadError = stale deploy; one-shot loop-guarded reload (shared with
    // app/error.tsx + lib/toast). A hard reload of /artwork/X lands on the
    // canonical page, bypassing interception.
    if (error.name === 'ChunkLoadError' && reloadOnceForChunkError()) return
    console.error('[modal-error-boundary]', { name: error.name, digest: error.digest })
  }, [error])

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Artwork failed to load"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) dismiss() }}
    >
      <div className="text-center font-mono">
        <p className="text-sm text-ink mb-2">couldn&apos;t load this artwork</p>
        <p className="text-xs text-muted mb-4">something went wrong opening it.</p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={() => startTransition(() => { router.refresh(); reset() })}
            className="px-4 py-2 text-xs border border-line text-dim hover:border-muted hover:text-ink transition-colors"
          >
            try again
          </button>
          <button
            onClick={dismiss}
            className="px-4 py-2 text-xs border border-line text-muted hover:border-muted hover:text-dim transition-colors"
          >
            close
          </button>
        </div>
      </div>
    </div>
  )
}
