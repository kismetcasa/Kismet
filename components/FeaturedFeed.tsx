'use client'

import { useEffect, useState } from 'react'
import type { Moment } from '@/lib/inprocess'
import { MomentCard } from './MomentCard'
import { CollectionRow, type FeaturedCollectionRow } from './CollectionRow'
import { FeaturedMoment } from './FeaturedMoment'
import { MaybeLazy } from './LazyMount'

// Number of moments rendered as a single grid row before the next collection
// breaks in. Picked to match the lg+ 4-col grid so the collection always
// appears at a visual row boundary rather than mid-row.
const STRIDE = 4

interface MintPassDisplayRef {
  address: string
  tokenId: string
}

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
  // Per-endpoint state so the moments grid paints when /api/timeline
  // returns, not when both endpoints have. null = pending, [] = empty.
  const [moments, setMoments] = useState<Moment[] | null>(null)
  const [collections, setCollections] = useState<FeaturedCollectionRow[] | null>(null)
  // Curated Mint Pass Displays (ordered newest-first). Just the refs — each
  // FeaturedMoment hydrates itself — so the list scales without a bespoke
  // batch endpoint.
  const [displays, setDisplays] = useState<MintPassDisplayRef[]>([])

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
    fetch('/api/featured')
      .then((r) => (r.ok ? r.json() : { mintPassDisplays: [] }))
      .catch(() => ({ mintPassDisplays: [] }))
      .then((d) => {
        if (cancelled) return
        const refs: MintPassDisplayRef[] = Array.isArray(d?.mintPassDisplays)
          ? d.mintPassDisplays
              .filter(
                (m: { collectionAddress?: string; tokenId?: string }) =>
                  m?.collectionAddress && m?.tokenId,
              )
              .map((m: { collectionAddress: string; tokenId: string }) => ({
                address: m.collectionAddress,
                tokenId: m.tokenId,
              }))
          : []
        setDisplays(refs)
      })
    return () => { cancelled = true }
  }, [])

  // Mint Pass Displays lead the tab as full-bleed showcases, newest first.
  // Each owns its own fetch + skeleton, so they paint independently of the
  // grid/collections feed below. Lazy-mount past the first few on mobile so
  // a large curated set doesn't mount every heavy hero at once.
  const showcase = displays.length > 0 ? (
    <div className="flex flex-col gap-6">
      {displays.map((d, i) => (
        <MaybeLazy key={`${d.address}-${d.tokenId}`} index={i} lazy={isMobile}>
          {() => <FeaturedMoment address={d.address} tokenId={d.tokenId} priority={i === 0} />}
        </MaybeLazy>
      ))}
    </div>
  ) : null

  if (moments === null) {
    return (
      <div className="flex flex-col gap-6 pt-4">
        {showcase}
        <div className="py-8 text-center text-xs font-mono text-muted">loading…</div>
      </div>
    )
  }

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
  while (mIdx < moments.length || cIdx < safeCollections.length) {
    const take = Math.min(STRIDE, moments.length - mIdx)
    if (take > 0) {
      blocks.push({ kind: 'moments', items: moments.slice(mIdx, mIdx + take) })
      mIdx += take
    }
    if (cIdx < safeCollections.length) {
      blocks.push({ kind: 'collection', row: safeCollections[cIdx++] })
    }
  }

  // Wait for collections too before showing empty — otherwise the tab
  // flashes "empty" between moments resolving empty and collections done.
  // Skip the empty message entirely when Mint Pass Displays lead the tab, so
  // it never reads "nothing here" above a wall of showcases.
  if (blocks.length === 0 && collections !== null && displays.length === 0) {
    return (
      <div className="flex flex-col gap-6 pt-4">
        {showcase}
        <div className="py-8 text-center text-xs font-mono text-muted">{emptyMessage}</div>
      </div>
    )
  }

  // Running flat index across moment-blocks so MaybeLazy's eager-count
  // threshold applies to the feed as a whole, not per-block. Without this,
  // every moments block would re-eager its first N cards and the lazy-mount
  // gate would only kick in within a single block — useless once the first
  // collection row breaks the run.
  let flatMomentIdx = 0

  return (
    <div className="flex flex-col gap-6 pt-4">
      {showcase}
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
