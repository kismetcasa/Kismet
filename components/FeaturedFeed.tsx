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
  // (already fetched for the feature stars), so picking the display mint costs
  // no extra /api/featured round-trip here. FeaturedMoment self-fetches that
  // one mint's detail; mintPassKeys only tells us which key it is.
  const { mintPassKeys } = useAdmin()
  // Per-endpoint state so the moments grid paints when /api/timeline
  // returns, not when both endpoints have. null = pending, [] = empty.
  const [moments, setMoments] = useState<Moment[] | null>(null)
  const [collections, setCollections] = useState<FeaturedCollectionRow[] | null>(null)
  // Whether the hero (if one is configured) actually paints — FeaturedMoment
  // reports false when its mint is hidden or the fetch fails. Starts true so the
  // empty message stays suppressed while the hero loads (no flash), then
  // corrects if it turns out blank. Resets on each remount (featuredRevision).
  const [heroHasContent, setHeroHasContent] = useState(true)

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

  // The curated Mint Pass Display — one at a time, always leading the tab.
  // FeaturedMoment renders it in two CSS-toggled presentations (a rich hero at
  // lg+, an ordinary card below lg), so the VIEWPORT alone — not a device/UA/
  // miniapp guess — decides which one shows. That's why there's no isMobile/
  // inMiniApp gate here: the same node is correct on web, mobile, and every
  // embed. FeaturedMoment self-fetches, so it shows even for a mint that only
  // appears inside a featured collection (never as a standalone timeline mint).
  const displayKey = mintPassKeys.size > 0 ? [...mintPassKeys][0] : undefined
  const keyOf = (m: Moment) => `${m.address?.toLowerCase()}:${m.token_id}`
  const colon = displayKey ? displayKey.indexOf(':') : -1
  const hero = displayKey && colon > 0
    ? (
      <FeaturedMoment
        // Key by the mint so a different display mounts a fresh instance,
        // never inheriting the prior one's fetch/ratio/resolved state.
        key={displayKey}
        address={displayKey.slice(0, colon)}
        tokenId={displayKey.slice(colon + 1)}
        priority
        onResolved={setHeroHasContent}
      />
    )
    : null

  // Show the display mint exactly once — as the hero above. Pull it out of the
  // standalone-moments grid here, and out of any collection row it belongs to
  // below (safeCollections), so it never double-appears: beside the desktop
  // hero, or beside the promoted card the hero renders below lg.
  const gridMoments = displayKey
    ? moments.filter((m) => keyOf(m) !== displayKey)
    : moments

  // Interleave: STRIDE moments → 1 collection → STRIDE moments → ...
  // Both lists arrive sorted by featuredAt desc, so the result is roughly
  // chronological with a predictable cadence regardless of skew.
  type Block =
    | { kind: 'moments'; items: Moment[] }
    | { kind: 'collection'; row: FeaturedCollectionRow }

  // Strip the display mint from its collection row too (see gridMoments) so the
  // hero is its only appearance. CollectionRow already renders a graceful
  // "no moments yet" if this empties a single-mint collection's preview.
  const safeCollections = displayKey
    ? (collections ?? []).map((c) => ({ ...c, moments: c.moments.filter((m) => keyOf(m) !== displayKey) }))
    : (collections ?? [])
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
  // Gate on what the hero actually PAINTS, not just that one is configured:
  // FeaturedMoment renders null for a hidden/failed display, and `hero` is a
  // truthy element regardless — so without heroHasContent a sole hidden/failed
  // display would leave the tab blank (no showcase AND no message).
  if (blocks.length === 0 && collections !== null && !(hero && heroHasContent)) {
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
