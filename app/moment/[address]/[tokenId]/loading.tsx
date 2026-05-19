// Renders during the brief window between a client-side route change to
// /moment/<address>/<tokenId> and the server's generateMetadata +
// fetchMomentDetail resolving. Without this, the browser shows a blank
// white page during the fetch — Mini App users misread that flash as
// the FC splash "reappearing" because the FC splash is also white.
//
// Skeleton geometry mirrors MomentDetailView's: hero image block, then
// title + description placeholders, then price/collect-button row.
// Match rough dimensions so the painted page doesn't shift when the
// real content lands.
export default function MomentLoading() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8 animate-pulse">
      <div className="flex flex-col gap-6">
        {/* Hero media — square placeholder. Real card is roughly square
            on mobile, wider on desktop, so a 1:1 box covers both. */}
        <div className="w-full aspect-square bg-raised" />
        {/* Title */}
        <div className="h-5 w-2/3 bg-raised rounded" />
        {/* Description (3 short lines) */}
        <div className="flex flex-col gap-2">
          <div className="h-3 w-full bg-raised/60 rounded" />
          <div className="h-3 w-11/12 bg-raised/60 rounded" />
          <div className="h-3 w-3/4 bg-raised/60 rounded" />
        </div>
        {/* Price + collect button row */}
        <div className="flex gap-2 items-stretch">
          <div className="h-10 w-28 bg-raised rounded" />
          <div className="h-10 flex-1 bg-raised rounded" />
        </div>
      </div>
    </div>
  )
}
