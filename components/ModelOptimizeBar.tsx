'use client'

import { formatCfileSize } from '@/lib/collectorFileTypes'
import type { OptimizeStep } from '@/lib/media/optimizeModel'

/**
 * The size chip on a posed 3D preview, with the one action attached to it:
 * "optimize for web" (lib/media/optimizeModel). Shows the live size of what
 * will ship, the step in progress, and — once optimized — the size it was,
 * with an undo, so replacing the artist's file is never silent.
 */
export function ModelOptimizeBar({
  size,
  busy,
  optimized,
  onOptimize,
  onUndo,
}: {
  size: number
  busy: OptimizeStep | null
  optimized: { before: number } | null
  onOptimize: () => void
  onUndo: () => void
}) {
  return (
    <div
      className="absolute top-2 left-2 flex items-center gap-2 px-2.5 py-1 bg-[#0d0d0d]/85 text-[10px] font-mono text-muted"
      aria-live="polite"
    >
      <span className="text-ink">{formatCfileSize(size)}</span>
      {busy ? (
        <span>optimizing… {busy}</span>
      ) : optimized ? (
        <>
          <span>was {formatCfileSize(optimized.before)}</span>
          <button
            type="button"
            onClick={onUndo}
            className="uppercase tracking-wider text-dim hover:text-ink transition-colors"
          >
            undo
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onOptimize}
          className="uppercase tracking-wider text-dim hover:text-ink transition-colors"
        >
          optimize for web
        </button>
      )}
    </div>
  )
}
