import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { enrichMomentsWithKismetMeta } from '@/lib/momentEnrichment'
import { getSweepIndex, isSweepEnabled } from '@/lib/sweepIndex'
import {
  SWEEP_MAX_N,
  clampSweepN,
  selectSweepItems,
  sweepItemToMoment,
  type SweepIndexItem,
} from '@/lib/sweepIndexCore'

export const runtime = 'nodejs'

// The sweep candidate pool: the cheapest live ETH-priced mints across every
// tracked collection, from the hourly index (lib/sweepIndex.ts), re-filtered
// against the live hide sets and identity-enriched exactly like a feed page.
// Viewer-INDEPENDENT on purpose — no account parameter — so it caches at the
// edge; "already yours" and every live price/supply check happen on the
// client from one cross-collection multicall right before the wallet prompt
// (SWEEP_IMPLEMENTATION.md §3, §4.1). Returns 3n rows (min 30) so that
// verification can drop rows and still fill the basket from the reserve.
//
//   GET /api/sweep?n=10   → { enabled, updatedAt, eligible, maxN, n, items }
//                          → { enabled: false } while the flag is off
const PUBLIC_CACHE = 'public, s-maxage=30, stale-while-revalidate=120'
const NO_STORE = 'private, no-store'

interface SweepResponseItem extends SweepIndexItem {
  creatorProfile: { username: string | null; avatarUrl: string | null }
  collection: { name: string | null; image: string | null } | null
}

export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`sweep:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const n = clampSweepN(req.nextUrl.searchParams.get('n'))

  // Flag read fails CLOSED, uncached: a Redis blip must neither expose the
  // feature nor pin "off" into the shared cache for the window.
  let enabled: boolean
  try {
    enabled = await isSweepEnabled()
  } catch {
    return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': NO_STORE } })
  }
  if (!enabled) {
    return NextResponse.json({ enabled: false }, { headers: { 'Cache-Control': PUBLIC_CACHE } })
  }

  const index = await getSweepIndex()
  if (!index) {
    return NextResponse.json(
      { enabled: true, updatedAt: null, eligible: 0, maxN: SWEEP_MAX_N, n, items: [] },
      { headers: { 'Cache-Control': PUBLIC_CACHE } },
    )
  }

  // Hide sets are strictRead-backed (they throw on a Redis failure): fail
  // CLOSED — never serve the pool unfiltered — and don't cache the failure.
  let hiddenMoments: Set<string>
  let hiddenCollections: Set<string>
  let hiddenUsers: Set<string>
  try {
    ;[hiddenMoments, hiddenCollections, hiddenUsers] = await Promise.all([
      getHiddenMomentsSet(),
      getHiddenCollectionsSet(),
      getHiddenUsersSet(),
    ])
  } catch {
    return NextResponse.json(
      { error: 'Temporarily unavailable' },
      { status: 503, headers: { 'Cache-Control': NO_STORE } },
    )
  }
  const selected = selectSweepItems(index, { n, hiddenMoments, hiddenCollections, hiddenUsers })

  // Identity overlay through the feeds' single choke point (username, avatar,
  // curated-collection chip, hidden-identity scrub). Display-only: on a
  // failure the rows ship with bare addresses, which leaks nothing (the index
  // stores no names) and the client's shortAddress fallback renders them.
  let enriched: ReturnType<typeof sweepItemToMoment>[] | null = null
  try {
    enriched = await enrichMomentsWithKismetMeta(selected.map(sweepItemToMoment))
  } catch {
    enriched = null
  }
  const items: SweepResponseItem[] = selected.map((it, i) => {
    const m = enriched?.[i]
    return {
      ...it,
      creatorProfile: {
        username: m?.creator?.username ?? null,
        avatarUrl: m?.creator?.avatarUrl ?? null,
      },
      collection: m?.kismetCollection
        ? { name: m.kismetCollection.name, image: m.kismetCollection.image }
        : null,
    }
  })

  return NextResponse.json(
    { enabled: true, updatedAt: index.updatedAt, eligible: index.eligible, maxN: SWEEP_MAX_N, n, items },
    { headers: { 'Cache-Control': PUBLIC_CACHE } },
  )
}
