// Renders during the brief window between a client-side route change to
// /profile/<address> and the server's generateMetadata+resolveProfileWithSiblings
// resolving. Without this, the browser shows a blank white page during the
// fetch — Mini App users were misreading that flash as the FC splash
// "reappearing", because the FC splash also has a white background.
//
// Skeleton geometry mirrors ProfileView's: avatar circle on the left, a
// stack of three muted name/address lines on the right, then a stack of
// section header strips. Match the dimensions roughly so the painted
// page doesn't shift when the real content lands.
export default function ProfileLoading() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12 flex flex-col gap-12 animate-pulse">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-6">
          <div className="w-20 h-20 rounded-full bg-raised" />
          <div className="flex flex-col gap-2">
            <div className="h-4 w-32 bg-raised rounded" />
            <div className="h-3 w-44 bg-raised/60 rounded" />
          </div>
        </div>
      </div>
      <div className="flex flex-col">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="border-t border-line py-4 flex items-center gap-2"
          >
            <div className="h-3 w-3 bg-raised rounded" />
            <div className="h-3 w-24 bg-raised rounded" />
          </div>
        ))}
      </div>
    </div>
  )
}
