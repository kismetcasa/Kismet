import { Box } from 'lucide-react'

/**
 * The one visible signal that a still is a 3D moment. Every surface except
 * the artwork page renders a model's captured still (GLB_3D_VIEWER_DESIGN.md
 * §5: one WebGL context, ever), so without this a 3D piece is indistinguishable
 * from a photograph of itself — the badge is what tells a viewer there is
 * something to tap through to. Position is the caller's: each surface has its
 * own corner budget (MomentCard's are all spoken for, so it steps aside for
 * the hidden badge; the hero's top-right is free).
 */
export function ModelBadge({ className = '' }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="3D artwork"
      title="3D artwork"
      className={`pointer-events-none z-10 flex items-center gap-1 px-1.5 py-0.5 bg-[#0d0d0d]/80 border border-line text-[9px] font-mono uppercase tracking-wider text-dim ${className}`}
    >
      <Box size={9} strokeWidth={1.5} />
      3D
    </span>
  )
}
