// Renders during the brief window between a client-side route change to
// /collection/<address> and the server's generateMetadata +
// fetchCollectionMoments resolving. Without this, the browser shows a
// blank white page during the fetch — Mini App users misread that flash
// as the FC splash "reappearing" because the FC splash is also white.
//
// Skeleton geometry mirrors CollectionView's: cover image / chip header,
// title + description placeholders, then a moments grid. Approximate the
// final dimensions so the painted page doesn't shift when content lands.
export default function CollectionLoading() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 animate-pulse">
      {/* Header block — cover + title/description */}
      <div className="flex gap-4 items-start mb-8">
        <div className="w-20 h-20 sm:w-32 sm:h-32 bg-raised flex-shrink-0" />
        <div className="flex-1 flex flex-col gap-2">
          <div className="h-5 w-40 bg-raised rounded" />
          <div className="h-3 w-56 bg-raised/60 rounded" />
          <div className="h-3 w-44 bg-raised/60 rounded" />
        </div>
      </div>
      {/* Moments grid skeleton — 6 cards in a responsive grid that
          roughly matches the real layout. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="w-full aspect-square bg-raised" />
            <div className="h-3 w-2/3 bg-raised/60 rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
