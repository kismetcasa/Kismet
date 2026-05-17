import { ModalOverlay } from '@/components/ModalOverlay'

/**
 * Renders while the IR route's server work (params + cookie read +
 * /moment fetch) resolves. Without it, Next.js holds the old URL and
 * clicks feel laggy on cold cache.
 */
export default function ModalMomentLoading() {
  return (
    <ModalOverlay>
      <div className="max-w-6xl mx-auto pb-16 animate-pulse">
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
