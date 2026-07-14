'use client'

import { useEffect, useState } from 'react'
import type { Moment } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'
import { MomentCard } from './MomentCard'
import { CollectionRow, type FeaturedCollectionRow } from './CollectionRow'
import { FeaturedMoment } from './FeaturedMoment'
import { MaybeLazy } from './LazyMount'
import { isPatronCollection } from '@/lib/patronCollection'

// Number of moments rendered as a single grid row before the next collection
// breaks in. Picked to match the lg+ 4-col grid so the collection always
// appears at a visual row boundary rather than mid-row.
const STRIDE = 4

// The standard moments grid: grows 1 → 2 → 3 → 4 columns up to lg+.
const FULL_GRID = 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4'

// When the whole feed is a single short row of standalone mints (a small,
// curated featured tab — e.g. 3 mints), stretch the cards to fill the width
// instead of leaving a trailing empty column at lg+. We drop the higher-
// breakpoint column caps so the row tops out at exactly `count` columns and
// each card grows to fill. Static class strings so Tailwind's JIT emits them;
// only applied to a lone moments block, so multi-row feeds keep uniform card
// sizes via FULL_GRID. 4+ items already fill the row, so they fall through.
function fillGridClass(count: number): string {
  switch (count) {
    case 2:
      return 'grid grid-cols-1 sm:grid-cols-2 gap-4'
    case 3:
      return 'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4'
    default:
      return FULL_GRID
  }
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
  // FeaturedMoment renders a rich hero at lg+ and an ordinary card below lg.
  // On desktop both mount and CSS toggles between them as the window resizes;
  // on mobile (the SSR isMobile flag) only the card mounts, because the lg+
  // hero's `priority` artwork preloads even while display:none and would starve
  // the visible card's fetch in the miniapp's shared HTTP/2 pool — the blank/
  // pulsing-artwork bug. We hand it the mint's timeline moment as initialMoment
  // so the artwork paints immediately; it still self-fetches to enrich (and to
  // show even for a mint that only lives inside a featured collection).
  const displayKey = mintPassKeys.size > 0 ? [...mintPassKeys][0] : undefined
  const keyOf = (m: Moment) => `${m.address?.toLowerCase()}:${m.token_id}`
  const colon = displayKey ? displayKey.indexOf(':') : -1
  // The mint is usually already in the featured-timeline payload (we filter it
  // out of the grid below). Pass it so BOTH presentations' artwork paints from
  // that metadata immediately — the same payload every other feed card already
  // renders from — instead of lagging FeaturedMoment's own /api/moment fetch.
  // Undefined when the mint lives only inside a featured collection.
  const displayMoment = displayKey ? moments.find((m) => keyOf(m) === displayKey) : undefined
  // The Mint Pass Display leads the tab. The two surfaces are deliberately
  // different:
  //   • DESKTOP — FeaturedMoment's rich 3-column hero (the special presentation).
  //   • MOBILE  — there is NO special presentation; it's just a normal card. So
  //     when the mint is in the timeline payload we render it as a plain
  //     MomentCard with the EXACT same props every other featured card uses —
  //     same component, same image path, priority={false} like every mobile card
  //     — so it cannot load or look any different from them. No FeaturedMoment
  //     wrapper, no /api/moment self-fetch competing in the miniapp's pool, no
  //     detail-driven showCreator override, and no priority preload (mobile
  //     preloads nothing — see the grid below; a preload fetches during bootstrap
  //     and lags in the miniapp's shared pool).
  // Only when the mint isn't a standalone timeline entry (no displayMoment — it
  // lives solely inside a featured collection) do we fall back to FeaturedMoment
  // on mobile too, which self-fetches that one mint so it can render at all.
  const hero = displayKey && colon > 0
    ? isMobile && displayMoment
      ? (
        // NO priority on mobile — render exactly like the other featured cards,
        // which load instantly precisely because they DON'T preload. `priority`
        // injects a <link rel=preload as=image> into <head> that fetches during
        // app bootstrap and competes with the critical JS/CSS in the miniapp's
        // tiny shared HTTP/2 pool, so the preloaded image lags behind the
        // non-preloaded grid cards (which fetch after hydration, once the pool is
        // free). MomentImage force-eagers it in the miniapp via skipDirectWalk,
        // so it still loads eagerly — just without the counter-productive preload.
        // Now byte-identical to a grid card. (Desktop keeps the rich priority
        // hero in the FeaturedMoment branch below.)
        <MomentCard
          key={displayKey}
          moment={displayMoment}
          priority={false}
          isMobile={isMobile}
          // Patron mints are physical-artwork scans heavy enough to 413 the
          // next/image optimizer; skip it and go straight to the downscaling
          // proxy so we don't re-pay that doomed round-trip (+ its blink) on
          // every load. Normal featured displays keep the optimizer.
          preferProxy={isPatronCollection(displayMoment.address)}
        />
      )
      : (
        <FeaturedMoment
          // Key by the mint so a different display mounts a fresh instance,
          // never inheriting the prior one's fetch/ratio/resolved state.
          key={displayKey}
          address={displayKey.slice(0, colon)}
          tokenId={displayKey.slice(colon + 1)}
          initialMoment={displayMoment}
          isMobile={isMobile}
          priority
          onResolved={setHeroHasContent}
        />
      )
    : null

  // The display mint leads the tab as the hero above, so pull it out of the
  // loose standalone grid here — otherwise (DISPLAY ⊆ FEATURED) it would also
  // sit as a duplicate card beside the desktop hero / below the promoted card
  // the hero renders at <lg. It is intentionally left IN its collection row,
  // though: a collection should show its full contents, including the member
  // that happens to be the current hero.
  const gridMoments = displayKey
    ? moments.filter((m) => keyOf(m) !== displayKey)
    : moments

  // Interleave: STRIDE moments → 1 collection → STRIDE moments → ...
  // Both lists arrive sorted by featuredAt desc, so the result is roughly
  // chronological with a predictable cadence regardless of skew.
  type Block =
    | { kind: 'moments'; items: Moment[] }
    | { kind: 'collection'; row: FeaturedCollectionRow }

  const featuredCollections = collections ?? []
  const blocks: Block[] = []
  let mIdx = 0
  let cIdx = 0
  while (mIdx < gridMoments.length || cIdx < featuredCollections.length) {
    const take = Math.min(STRIDE, gridMoments.length - mIdx)
    if (take > 0) {
      blocks.push({ kind: 'moments', items: gridMoments.slice(mIdx, mIdx + take) })
      mIdx += take
    }
    if (cIdx < featuredCollections.length) {
      blocks.push({ kind: 'collection', row: featuredCollections[cIdx++] })
    }
  }

  // Only stretch standalone mints to fill the width when they form a single
  // short row in the whole feed — otherwise a short trailing row would render
  // wider cards than the full rows above it. Larger feeds keep FULL_GRID.
  const soleMomentBlock =
    blocks.filter((b) => b.kind === 'moments').length === 1

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
            className={soleMomentBlock ? fillGridClass(b.items.length) : FULL_GRID}
          >
            {/* Priority (the next/image <link rel=preload>) is DESKTOP-ONLY.
                Desktop's first block is a row of up to 4 columns, so its first 3
                are above the fold and benefit from the preload. On MOBILE we
                preload nothing: a preload fetches during app bootstrap and
                competes with the critical JS/CSS in the miniapp's tiny shared
                HTTP/2 pool, so a preloaded card lags behind the others (which
                fetch after hydration, pool free). MomentImage already force-
                eagers the visible cards in the miniapp via skipDirectWalk, so
                they still load promptly — just without the counter-productive
                preload. Keeping every mobile card priority={false} is also what
                makes the featured Mint Pass card load identically to the rest. */}
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
                      priority={isMobile ? false : i === 0 && idx < 3}
                      isMobile={isMobile}
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
            // Desktop-only preload, same rule as the grid above: on mobile we
            // preload nothing (preloads lag in the miniapp's shared pool), so
            // every surface loads uniformly.
            priority={isMobile ? false : i === 0}
            isMobile={isMobile}
          />
        ),
      )}
    </div>
  )
}
