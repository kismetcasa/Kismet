// The pulse-skeleton grid every feed shows while its first page loads —
// extracted from PaginatedGrid so the featured tab (and the pre-hydration
// gate on the landing page) render the same perceived-content placeholder
// instead of a bare "loading…" line. One source so the shapes can't drift.

// The standard 1→2→3→4-column feed grid. Exported as THE single source —
// FeaturedFeed's live grid imports it, so the skeleton's default and the
// real grid can't drift into different column counts (a layout jump on load).
export const FEED_GRID_CLASS = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4'

interface FeedSkeletonProps {
  count?: number
  gridClass?: string
  /** Padding/spacing of the text stub under each tile (grid vs list card). */
  bodyClass?: string
}

export function FeedSkeleton({
  count = 12,
  gridClass = FEED_GRID_CLASS,
  bodyClass = 'p-2 space-y-1.5',
}: FeedSkeletonProps) {
  return (
    <div className={gridClass}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-[#161616] border border-line">
          <div className="aspect-square bg-raised animate-pulse" />
          <div className={bodyClass}>
            <div className="h-3 bg-raised animate-pulse w-2/3" />
            <div className="h-3 bg-raised animate-pulse w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
