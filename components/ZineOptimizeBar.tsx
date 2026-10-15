'use client'

import { formatCfileSize } from '@/lib/collectorFileTypes'
import type { PdfOptimizeStep } from '@/lib/media/optimizePdf'

/**
 * The size chip on a zine preview, with the one action attached to it:
 * "optimize for phones" (lib/media/optimizePdf). Shows the live size of what
 * will ship, the page being re-rendered, and — once optimized — the size it
 * was, with an undo, so replacing the artist's file is never silent. The
 * twin of ModelOptimizeBar.
 */
export function ZineOptimizeBar({
  size,
  busy,
  optimized,
  hint,
  onOptimize,
  onUndo,
}: {
  size: number
  busy: PdfOptimizeStep | null
  optimized: { before: number } | null
  /** What the pass does to the file, as the button's tooltip — the artist
   *  is replacing their export, so the consequence is stated up front. */
  hint: string
  onOptimize: () => void
  onUndo: () => void
}) {
  return (
    <div
      className="absolute top-2 left-2 z-10 flex items-center gap-2 px-2.5 py-1 bg-[#0d0d0d]/85 text-[10px] font-mono text-muted"
      aria-live="polite"
    >
      <span className="text-ink">{formatCfileSize(size)}</span>
      {busy ? (
        <span>{busy.kind === 'page' ? `optimizing page ${busy.page} / ${busy.pages}` : 'writing…'}</span>
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
          title={hint}
          className="uppercase tracking-wider text-dim hover:text-ink transition-colors"
        >
          optimize for phones
        </button>
      )}
    </div>
  )
}
