import { BookOpen } from 'lucide-react'
import { formatZinePages } from '@/lib/media/zineMedia'

/**
 * The one visible signal that a still is a zine. Every surface except the
 * artwork page renders a zine's cover (ZINE_READER_DESIGN.md §11: the reader
 * mounts on the detail view alone, behind a tap), so without this a zine is
 * indistinguishable from a photograph of its cover — the badge is what tells
 * a viewer there are pages to read. Position is the caller's, exactly as
 * ModelBadge leaves it to each surface's corner budget.
 */
export function ZineBadge({ pages, className = '' }: { pages?: number; className?: string }) {
  const label = pages ? `zine, ${formatZinePages(pages)}` : 'zine'
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`pointer-events-none z-10 flex items-center gap-1 px-1.5 py-0.5 bg-[#0d0d0d]/80 border border-line text-[9px] font-mono uppercase tracking-wider text-dim ${className}`}
    >
      <BookOpen size={9} strokeWidth={1.5} />
      zine
    </span>
  )
}
