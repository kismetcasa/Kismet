'use client'

import { formatCfileSize } from '@/lib/collectorFileTypes'

/**
 * The size chip on a mint preview, with the one action attached to it — a
 * 3D model's "optimize for web" (lib/media/optimizeModel) or a zine's
 * "optimize for phones" (lib/media/optimizePdf). Shows the live size of what
 * will ship, the step in progress, and — once optimized — the size it was,
 * with an undo, so replacing the artist's file is never silent. One
 * component for both passes; the caller words the step and the button.
 */
export function OptimizeBar({
  size,
  busy,
  optimized,
  label,
  hint,
  onOptimize,
  onUndo,
}: {
  size: number
  /** The step in progress, or null when idle. The phase is what the live
   *  region announces ("optimizing…", once); the detail ("textures",
   *  "page 3 / 420") is visual only, so a screen reader is not read every
   *  page of a long zine. */
  busy: { phase: string; detail?: string } | null
  optimized: { before: number } | null
  /** The button's text. */
  label: string
  /** What the pass does to the file, as the button's tooltip — the artist
   *  is replacing their export, so a consequence is stated up front. */
  hint?: string
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
        <span>
          {busy.phase}
          {busy.detail ? <span aria-hidden="true"> {busy.detail}</span> : null}
        </span>
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
          {label}
        </button>
      )}
    </div>
  )
}
