import { ModalOverlay } from '@/components/ModalOverlay'

/**
 * Renders while the IR route's server work (params + cookie read +
 * /moment fetch) resolves. Without it, Next.js holds the old URL and
 * clicks feel laggy on cold cache.
 */
export default function ModalMomentLoading() {
  return (
    <ModalOverlay>
      <div className="max-w-[88rem] mx-auto px-3 sm:px-4 pt-3 sm:pt-4 pb-16 animate-pulse">
        <div className="md:grid md:grid-cols-2 border-b border-line">
          <div className="border-b border-line md:border-b-0 md:border-r md:border-r-line">
            <div className="aspect-square bg-surface" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="h-4 w-2/3 bg-raised" />
            <div className="h-3 w-1/3 bg-raised" />
            <div className="h-3 w-1/2 bg-raised" />
            <div className="h-16 w-full bg-surface mt-2" />
            <div className="flex gap-2 mt-4">
              <div className="h-10 w-24 bg-raised" />
              <div className="h-10 flex-1 bg-raised" />
            </div>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
