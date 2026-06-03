'use client'

import { useEffect, useState } from 'react'
import type { Moment } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'
import { MomentCard } from './MomentCard'
import { CollectionRow, type FeaturedCollectionRow } from './CollectionRow'
import { FeaturedMoment } from './FeaturedMoment'
import { MaybeLazy } from './LazyMount'

// Number of moments rendered as a single grid row before the next collection
// breaks in. Picked to match the lg+ 4-col grid so the collection always
// appears at a visual row boundary rather than mid-row.
const STRIDE = 4

interface FeaturedFeedProps {
  emptyMessage: string
  /** Server-decided lazy-mount toggle (mobile UA → true). When true, moment
   *  cards beyond EAGER_MOUNT_COUNT in flat-feed order defer mount until
   *  their placeholder enters the viewport. CollectionRow blocks always
   *  render eagerly — they're a single row with their own internal grid
   *  and don't multiply mount cost the way MomentCard cards do. */
  isMobile?: boolean
}

export function FeaturedFeed({ emptyMessage, isMobile = false }: FeaturedFeedProps) {
  // Which featured mints are Mint Pass Displays — sourced from AdminContext
  // (already fetched for the feature stars) so the hero reuses the mint's data
  // straight from the featured timeline below, with no extra /api/featured or
  // /api/moment round-trips.
  const { mintPassKeys } = useAdmin()
  // Per-endpoint state so the moments grid paints when /api/timeline
  // returns, not when both endpoints have. null = pending, [] = empty.
  const [moments, setMoments] = useState<Moment[] | null>(null)
  const [collections, setCollections] = useState<FeaturedCollectionRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/timeline?featured=1')
      .then((r) => (r.ok ? r.json() : { moments: [] }))
      .catch(() => ({ moments: [] }))
      .then((tl) => {
        if (cancelled) return
        setMoments(Array.isArray(tl?.moments) ? tl.moments : [])
      })
    fetch('/api/featured/collections-hydrated')
      .then((r) => (r.ok ? r.json() : { collections: [] }))
      .catch(() => ({ collections: [] }))
      .then((fc) => {
        if (cancelled) return
        setCollections(Array.isArray(fc?.collections) ? fc.collections : [])
      })
    return () => { cancelled = true }
  }, [])

  if (moments === null) {
    return <div className="py-8 text-center text-xs font-mono text-muted">loading…</div>
  }

  // The desktop hero (web-only) is the curated Mint Pass Display — one at a
  // time. Render it from its ref (FeaturedMoment self-fetches) so it shows
  // even when it isn't a standalone featured-timeline mint (e.g. a mint inside
  // a featured collection). On mobile/miniapp there's no hero — the mint shows
  // in the feed as a normal card / collection-row member instead.
  const displayKey = !isMobile && mintPassKeys.size > 0 ? [...mintPassKeys][0] : undefined
  const colon = displayKey ? displayKey.indexOf(':') : -1
  const hero = displayKey && colon > 0
    ? (
      <FeaturedMoment
        address={displayKey.slice(0, colon)}
        tokenId={displayKey.slice(colon + 1)}
        priority
      />
    )
    : null

  // Pull the hero mint out of the standalone-moments grid so it isn't shown
  // twice. (A copy may still appear inside its own collection row below — the
  // collection's full set is intentionally left complete.)
  const gridMoments = displayKey
    ? moments.filter((m) => `${m.address?.toLowerCase()}:${m.token_id}` !== displayKey)
    : moments

  // Interleave: STRIDE moments → 1 collection → STRIDE moments → ...
  // Both lists arrive sorted by featuredAt desc, so the result is roughly
  // chronological with a predictable cadence regardless of skew.
  type Block =
    | { kind: 'moments'; items: Moment[] }
    | { kind: 'collection'; row: FeaturedCollectionRow }

  const safeCollections = collections ?? []
  const blocks: Block[] = []
  let mIdx = 0
  let cIdx = 0
  while (mIdx < gridMoments.length || cIdx < safeCollections.length) {
    const take = Math.min(STRIDE, gridMoments.length - mIdx)
    if (take > 0) {
      blocks.push({ kind: 'moments', items: gridMoments.slice(mIdx, mIdx + take) })
      mIdx += take
    }
    if (cIdx < safeCollections.length) {
      blocks.push({ kind: 'collection', row: safeCollections[cIdx++] })
    }
  }

  // Wait for collections too before showing empty — otherwise the tab
  // flashes "empty" between moments resolving empty and collections done.
  // Skip it when the hero leads the tab so it never reads "nothing here"
  // above the showcase. (hero is null here by the guard.)
  if (blocks.length === 0 && collections !== null && !hero) {
    return <div className="py-8 text-center text-xs font-mono text-muted">{emptyMessage}</div>
  }

  // Running flat index across moment-blocks so MaybeLazy's eager-count
  // threshold applies to the feed as a whole, not per-block. Without this,
  // every moments block would re-eager its first N cards and the lazy-mount
  // gate would only kick in within a single block — useless once the first
  // collection row breaks the run.
  let flatMomentIdx = 0

  return (
    <div className="flex flex-col gap-6 pt-4">
      {hero}
      {blocks.map((b, i) =>
        b.kind === 'moments' ? (
          <div
            key={`m-${i}`}
            className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
          >
            {/* Prioritize the first row of moments only when it leads the
                feed (i === 0). Subsequent moment blocks render below other
                content and shouldn't compete with LCP. */}
            {b.items.map((m, idx) => {
              const flatIdx = flatMomentIdx++
              return (
                <MaybeLazy
                  key={m.id || `${m.address}-${m.token_id}`}
                  index={flatIdx}
                  lazy={isMobile}
                >
                  {() => (
                    <MomentCard
                      moment={m}
                      priority={i === 0 && idx < 3}
                    />
                  )}
                </MaybeLazy>
              )
            })}
          </div>
        ) : (
          <CollectionRow
            key={`c-${b.row.contractAddress}`}
            collection={b.row}
            priority={i === 0}
            isMobile={isMobile}
          />
        ),
      )}
    </div>
  )
}
