'use client'

import { useEffect, useState } from 'react'
import type { Moment } from '@/lib/inprocess'
import { MomentCard } from './MomentCard'
import { CollectionRow, type FeaturedCollectionRow } from './CollectionRow'

// Number of moments rendered as a single grid row before the next collection
// breaks in. Picked to match the lg+ 4-col grid so the collection always
// appears at a visual row boundary rather than mid-row.
const STRIDE = 4

interface FeaturedFeedProps {
  emptyMessage: string
}

export function FeaturedFeed({ emptyMessage }: FeaturedFeedProps) {
  const [moments, setMoments] = useState<Moment[]>([])
  const [collections, setCollections] = useState<FeaturedCollectionRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/timeline?featured=1')
        .then((r) => (r.ok ? r.json() : { moments: [] }))
        .catch(() => ({ moments: [] })),
      fetch('/api/featured/collections-hydrated')
        .then((r) => (r.ok ? r.json() : { collections: [] }))
        .catch(() => ({ collections: [] })),
    ]).then(([tl, fc]) => {
      if (cancelled) return
      setMoments(Array.isArray(tl?.moments) ? tl.moments : [])
      setCollections(Array.isArray(fc?.collections) ? fc.collections : [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Interleave: STRIDE moments → 1 collection → STRIDE moments → ...
  // Both lists arrive sorted by featuredAt desc, so the result is roughly
  // chronological with a predictable cadence regardless of skew.
  type Block =
    | { kind: 'moments'; items: Moment[] }
    | { kind: 'collection'; row: FeaturedCollectionRow }

  const blocks: Block[] = []
  let mIdx = 0
  let cIdx = 0
  while (mIdx < moments.length || cIdx < collections.length) {
    const take = Math.min(STRIDE, moments.length - mIdx)
    if (take > 0) {
      blocks.push({ kind: 'moments', items: moments.slice(mIdx, mIdx + take) })
      mIdx += take
    }
    if (cIdx < collections.length) {
      blocks.push({ kind: 'collection', row: collections[cIdx++] })
    }
  }

  if (loading) {
    return <div className="py-8 text-center text-xs font-mono text-[#555]">loading…</div>
  }

  if (blocks.length === 0) {
    return <div className="py-8 text-center text-xs font-mono text-[#555]">{emptyMessage}</div>
  }

  return (
    <div className="flex flex-col gap-6 pt-4">
      {blocks.map((b, i) =>
        b.kind === 'moments' ? (
          <div
            key={`m-${i}`}
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
          >
            {/* Prioritize the first row of moments only when it leads the
                feed (i === 0). Subsequent moment blocks render below other
                content and shouldn't compete with LCP. */}
            {b.items.map((m, idx) => (
              <MomentCard
                key={m.id || `${m.address}-${m.token_id}`}
                moment={m}
                priority={i === 0 && idx < 3}
              />
            ))}
          </div>
        ) : (
          <CollectionRow
            key={`c-${b.row.contractAddress}`}
            collection={b.row}
            priority={i === 0}
          />
        ),
      )}
    </div>
  )
}
