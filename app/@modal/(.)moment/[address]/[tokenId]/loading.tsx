import { ModalOverlay } from '@/components/ModalOverlay'

/**
 * Renders instantly when the user clicks a card and the IR route's
 * server work (params, cookie read, /moment fetch) hasn't resolved
 * yet. Without this, Next.js holds the old URL until the async page
 * completes — clicks feel laggy on cold cache. With it, the URL
 * updates immediately and the user sees the overlay skeleton.
 *
 * Skeleton mirrors the canonical detail layout (square media on
 * left, info column on right) so the transition into the real
 * MomentDetailView doesn't visibly shift.
 */
export default function ModalMomentLoading() {
  return (
    <ModalOverlay>
      <div className="max-w-6xl mx-auto pb-16 animate-pulse">
        <div className="px-4 py-3 border-b border-[#2a2a2a]">
          <div className="h-3 w-12 bg-[#1a1a1a]" />
        </div>
        <div className="md:grid md:grid-cols-2 border-b border-[#2a2a2a]">
          <div className="border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a]">
            <div className="aspect-square bg-[#111]" />
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <div className="h-4 w-2/3 bg-[#1a1a1a]" />
            <div className="h-3 w-1/3 bg-[#1a1a1a]" />
            <div className="h-3 w-1/2 bg-[#1a1a1a]" />
            <div className="h-16 w-full bg-[#111] mt-2" />
            <div className="flex gap-2 mt-4">
              <div className="h-10 w-24 bg-[#1a1a1a]" />
              <div className="h-10 flex-1 bg-[#1a1a1a]" />
            </div>
          </div>
        </div>
      </div>
    </ModalOverlay>
  )
}
