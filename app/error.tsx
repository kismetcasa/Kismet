'use client'

import { useEffect, startTransition } from 'react'
import { useRouter } from 'next/navigation'

// Segment-level error boundary. Catches throws from page server components
// and nested layouts. Does NOT catch generateMetadata throws — that's an
// open Next.js production bug (vercel/next.js#49925), so generateMetadata
// bodies are individually try/caught. global-error.tsx is the last-resort
// boundary for root-layout + generateMetadata.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  useEffect(() => {
    // ChunkLoadError = stale deploy. One-shot reload guarded by
    // sessionStorage so a real bug can't trigger a refresh loop.
    if (
      error.name === 'ChunkLoadError' &&
      typeof window !== 'undefined' &&
      !sessionStorage.getItem('chunk-reloaded')
    ) {
      sessionStorage.setItem('chunk-reloaded', '1')
      window.location.reload()
      return
    }
    console.error('[error-boundary]', { name: error.name, digest: error.digest })
  }, [error])

  return (
    <div role="alert" className="max-w-md mx-auto py-16 px-4 text-center font-mono">
      <h2 className="text-sm text-ink mb-2">something went wrong</h2>
      <p className="text-xs text-muted mb-4">we've been notified.</p>
      {error.digest && (
        <p className="text-[10px] text-faint mb-4">
          reference: <code>{error.digest}</code>
        </p>
      )}
      <button
        // reset() alone re-renders the client subtree without re-fetching
        // server data — clicking would re-render the same broken cache.
        // router.refresh() invalidates the RSC cache; pair them under
        // startTransition so React schedules them together.
        onClick={() => startTransition(() => { router.refresh(); reset() })}
        className="px-4 py-2 text-xs border border-line text-dim hover:border-muted hover:text-ink transition-colors"
      >
        try again
      </button>
    </div>
  )
}
