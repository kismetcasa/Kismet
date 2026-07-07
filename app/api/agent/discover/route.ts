import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getListings, type Listing } from '@/lib/listings'
import { fetchCollectionMoments, resolveUri, formatPrice, type Moment } from '@/lib/inprocess'
import { getCollectedMembers } from '@/lib/collected'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getListingVisibility } from '@/lib/hiddenListings'
import { getMomentMetaBatch } from '@/lib/notifications'
import { priceToBaseUnits } from '@/lib/agent/list'

export const runtime = 'nodejs'

/**
 * Free-tier discovery for agents: turns "find me…" into actionable rows. Each
 * row carries a `nextAction` hint pointing at the right prepare endpoint with a
 * suggested body, so the agent can go discover → prepare → execute without
 * guessing identifiers.
 *
 *   kind=listings (default) → active Seaport listings to buy  → nextAction: buy
 *   kind=collect            → moments in a collection to mint → nextAction: collect
 *
 * Read-only. The richer "curated" tier (taste-matching, cross-source ranking)
 * is the planned x402-gated upgrade.
 */
interface DiscoverRow {
  kind: 'listing' | 'collectable'
  collection: string
  tokenId: string
  name?: string
  image?: string
  price?: string
  priceLabel?: string
  currency?: 'eth' | 'usdc'
  listingId?: string
  seller?: string
  momentUrl: string
  nextAction: { verb: 'buy' | 'collect'; endpoint: string; method: 'POST'; suggestedBody: Record<string, unknown> }
}

export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`agent-discover:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const url = new URL(req.url)
  const origin = url.origin
  const { searchParams } = url

  const kind = searchParams.get('kind') === 'collect' ? 'collect' : 'listings'
  const collection = searchParams.get('collection') ?? undefined
  const currencyParam = searchParams.get('currency')
  const currency: 'eth' | 'usdc' | undefined =
    currencyParam === 'usdc' ? 'usdc' : currencyParam === 'eth' ? 'eth' : undefined
  const maxPrice = searchParams.get('maxPrice') ?? undefined
  const account = searchParams.get('account') ?? undefined
  const excludeCollectedBy = searchParams.get('excludeCollectedBy') ?? undefined
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '20') || 20))

  if (collection && !isAddress(collection)) return errorResponse(400, 'Invalid collection address')
  if (account && !isAddress(account)) return errorResponse(400, 'Invalid account address')
  if (excludeCollectedBy && !isAddress(excludeCollectedBy)) return errorResponse(400, 'Invalid excludeCollectedBy address')

  const momentUrl = (c: string, t: string) => `${origin}/moment/${c}/${t}`
  const accountBody = account ? { account } : {}

  if (kind === 'collect') {
    if (!collection) return errorResponse(400, 'collection is required for kind=collect')

    let moments: Moment[] = []
    try {
      moments = await fetchCollectionMoments(collection, { limit })
    } catch {
      moments = []
    }

    let collected = new Set<string>()
    if (excludeCollectedBy) {
      try {
        collected = new Set(await getCollectedMembers(excludeCollectedBy))
      } catch {
        collected = new Set()
      }
    }

    // Agent discovery is a public feed surface — apply the same hide
    // filters the timeline applies (hidden moments, hidden collections,
    // admin-hidden creators). Creator attribution is KV-STITCHED first,
    // exactly like the timeline: inprocess attributes mint-proxy and
    // cover-mint moments to the platform smart wallet / defaultAdmin, so
    // filtering on the raw feed creator would let an admin-hidden artist's
    // Kismet-minted moments stay agent-discoverable. Without any of this,
    // agents could enumerate content every human-facing feed suppresses.
    //
    // The whole block degrades to zero rows on Redis failure: fail-closed
    // for hidden content (nothing is revealed) without turning a blip into
    // a 5xx — this route's pre-existing contract degrades every upstream
    // failure to empty rows, and before the hide filters it had no Redis
    // dependency at all.
    let rows: DiscoverRow[] = []
    try {
      const [hiddenMoments, hiddenCollections, hiddenUsers] = await Promise.all([
        getHiddenMomentsSet(),
        getHiddenCollectionsSet(),
        getHiddenUsersSet(),
      ])

      const candidates = moments.filter(
        (m) => m.address && m.token_id && !collected.has(`${m.address.toLowerCase()}:${m.token_id}`),
      )
      const metas =
        hiddenUsers.size > 0
          ? await getMomentMetaBatch(
              candidates.map((m) => ({ address: m.address, tokenId: m.token_id })),
            )
          : []

      rows = candidates
        .filter((m, i) => {
          const addr = m.address.toLowerCase()
          if (hiddenMoments.has(`${addr}:${m.token_id}`) || hiddenCollections.has(addr)) return false
          const creator = (metas[i]?.creator ?? m.creator?.address)?.toLowerCase()
          return !creator || !hiddenUsers.has(creator)
        })
        .slice(0, limit)
        .map((m) => ({
        kind: 'collectable',
        collection: m.address,
        tokenId: m.token_id,
        name: m.metadata?.name,
        image: m.metadata?.image ? resolveUri(m.metadata.image) : undefined,
        momentUrl: momentUrl(m.address, m.token_id),
        nextAction: {
          verb: 'collect',
          endpoint: '/api/agent/prepare-collect',
          method: 'POST',
          suggestedBody: { collection: m.address, tokenId: m.token_id, ...accountBody },
        },
      }))
    } catch {
      rows = []
    }

    return NextResponse.json(
      { kind: 'collect', count: rows.length, rows, note: 'Price and eligibility are resolved by prepare-collect.' },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }

  // kind === 'listings'
  let listings: Listing[] = []
  try {
    const res = await getListings({ page: 1, limit: 50, collection })
    listings = res.listings
  } catch {
    listings = []
  }

  const cap = maxPrice && currency ? priceToBaseUnits(maxPrice, currency) : undefined

  // Same visibility rules as the /api/listings market feed: per-listing
  // hides, the hidden-moment/collection cascade, and hidden sellers/creators
  // all apply to agents too. Degrades to zero rows on Redis failure — see
  // the collect branch for the rationale.
  let rows: DiscoverRow[] = []
  try {
    const visibility = await getListingVisibility()

    rows = listings
      .filter((l) => !visibility.feedHidden(l))
      .filter((l) => (currency ? (l.currency ?? 'eth') === currency : true))
      .filter((l) => {
        if (cap === undefined) return true
        try {
          return BigInt(l.price) <= cap
        } catch {
          return false
        }
      })
      .slice(0, limit)
      .map((l) => ({
        kind: 'listing',
        collection: l.collectionAddress,
        tokenId: l.tokenId,
        name: l.name,
        image: l.image ? resolveUri(l.image) : undefined,
        price: l.price,
        priceLabel: formatPrice(l.price, l.currency ?? 'eth'),
        currency: l.currency ?? 'eth',
        listingId: l.id,
        seller: l.seller,
        momentUrl: momentUrl(l.collectionAddress, l.tokenId),
        nextAction: {
          verb: 'buy',
          endpoint: '/api/agent/prepare-buy',
          method: 'POST',
          suggestedBody: { listingId: l.id, ...accountBody },
        },
      }))
  } catch {
    rows = []
  }

  return NextResponse.json(
    {
      kind: 'listings',
      count: rows.length,
      rows,
      note: cap !== undefined ? `Filtered to ${currency} ≤ ${maxPrice}.` : undefined,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
