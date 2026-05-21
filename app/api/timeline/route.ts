import { NextRequest, NextResponse } from 'next/server'
import { getTrackedCollectionsByScope, getCreatedMintsSet, type CollectionScope } from '@/lib/kv'
import { inprocessUrl } from '@/lib/inprocess'
import { redis, FEATURED_KEY, TRENDING_KEY } from '@/lib/redis'
import { getCollectedMembers } from '@/lib/collected'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getSessionAddress } from '@/lib/session'
import { getMomentMetaBatch } from '@/lib/notifications'
import { expandToFidSiblings } from '@/lib/addressUnion'
import { enrichMomentsWithKismetMeta } from '@/lib/momentEnrichment'
import type { Moment } from '@/lib/inprocess'

async function fetchCollection(collection: string, limit: number): Promise<unknown[]> {
  const url = inprocessUrl('/timeline', { collection, limit, chain_id: '8453' })
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, next: { revalidate: 30 } })
    const text = await res.text()
    const data = JSON.parse(text)
    return Array.isArray(data.moments) ? data.moments : []
  } catch {
    return []
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1') || 1)
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '20') || 20))
  const creatorRaw = searchParams.get('creator')?.toLowerCase() ?? undefined
  const collectorRaw = searchParams.get('collector')?.toLowerCase() ?? undefined
  // Address union: if either address is Farcaster-verified, expand to
  // every verified address of the same FID. This is what makes a user's
  // profile feed show their mints/collected regardless of which of their
  // wallets they happen to sign each action from — see
  // lib/addressUnion.ts. Non-FC addresses pass through as a single-
  // element set, so for them the behavior is identical to the old
  // strict-equality filter.
  const [creatorAddrs, collectorAddrs] = await Promise.all([
    creatorRaw ? expandToFidSiblings(creatorRaw) : Promise.resolve<string[] | null>(null),
    collectorRaw ? expandToFidSiblings(collectorRaw) : Promise.resolve<string[] | null>(null),
  ])
  const creatorSet = creatorAddrs ? new Set(creatorAddrs) : null
  const collectorSet = collectorAddrs ? new Set(collectorAddrs) : null
  // Moments where this address holds admin authority — creator OR a
  // per-token ADMIN delegate. Distinct from ?creator= which is the
  // strict "their work" filter used by profile feeds.
  const airdroppable = searchParams.get('airdroppable')?.toLowerCase() ?? undefined
  const sort = searchParams.get('sort') // 'trending' | null
  const featured = searchParams.get('featured') === '1'
  const followingParam = searchParams.get('following')
  const followingSet = followingParam
    ? new Set(followingParam.split(',').map((a) => a.toLowerCase()).filter(Boolean))
    : null

  const singleCollection = searchParams.get('collection')?.toLowerCase() ?? null

  // standalone = strict Mints surface (filtered post-merge by created-mints
  // membership). collections = curated only (Create Collection deploys).
  // all = every tracked contract, no narrowing.
  const rawScope = searchParams.get('scope')
  const scope: CollectionScope =
    rawScope === 'standalone' || rawScope === 'collections' ? rawScope : 'all'

  // Curated roster: ?creators=0xa,0xb. Empty value matches nothing
  // (so an empty roster shows its empty state, not the full feed).
  const creatorsParam = searchParams.get('creators')
  const creatorsSet =
    creatorsParam !== null
      ? new Set(
          creatorsParam
            .split(',')
            .map((a) => a.trim().toLowerCase())
            .filter((a) => /^0x[a-f0-9]{40}$/.test(a)),
        )
      : null
  const filterToCreators = creatorsSet !== null

  // Pre-read the collector's zset so we can both (a) seed the fan-out
  // with any collections referenced there but absent from the tracked
  // set — otherwise an airdrop into an untracked collection silently
  // disappears from the recipient's Collected tab — and (b) skip the
  // second zrange below in the filter stage.
  //
  // When the collector address belongs to a Farcaster user, the zset is
  // unioned across all of that FID's verified addresses so that pieces
  // collected from any of their wallets surface together. Each address
  // gets a parallel zrange; the merged set is deduped via Set semantics.
  let collectedSet: Set<string> | null = null
  let collectedCollections: string[] = []
  if (collectorAddrs && collectorAddrs.length > 0) {
    const pairsPerAddr = await Promise.all(
      collectorAddrs.map((a) => getCollectedMembers(a)),
    )
    collectedSet = new Set(pairsPerAddr.flat())
    const fromZset = new Set<string>()
    for (const pair of collectedSet) {
      const colon = pair.indexOf(':')
      if (colon > 0) fromZset.add(pair.slice(0, colon).toLowerCase())
    }
    collectedCollections = Array.from(fromZset)
  }

  const trackedCollections = singleCollection
    ? [singleCollection]
    : await getTrackedCollectionsByScope(scope)

  // Union with any collections found in the collector's zset. Order
  // doesn't matter (results are merged + deduped below), but a Set
  // dedupe avoids re-fetching collections that are in both lists.
  const collections = Array.from(
    new Set([...trackedCollections, ...collectedCollections]),
  )

  // Cross-collection sort, featured curation, and the creators allowlist
  // can each thin the result set below `page * limit`. Bump the per-
  // collection sample so paginated pages don't empty out prematurely.
  const needsLargerSample = sort === 'trending' || featured || filterToCreators
  const fetchLimit = needsLargerSample ? Math.max(page * limit, 200) : page * limit
  const results = await Promise.all(collections.map((c) => fetchCollection(c, fetchLimit)))

  // Merge and deduplicate
  const seen = new Set<string>()
  let merged = results.flat().filter((m: unknown) => {
    const moment = m as { id?: string }
    const key = moment.id ?? JSON.stringify(m)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Curated creator allowlist — narrows to moments by the listed creators.
  // Applied early (before the broader `creator` profile filter and before
  // sort/featured) so downstream stages all see the already-narrowed set.
  if (filterToCreators && creatorsSet) {
    merged = merged.filter((m: unknown) => {
      const moment = m as { creator?: { address?: string } }
      const addr = moment.creator?.address?.toLowerCase()
      return addr ? creatorsSet.has(addr) : false
    })
  }

  // Strict Mints surface: only moments tracked in created-mints (mints
  // via MintForm + covers minted at Create-Collection time) appear.
  // Profile/Roster/Featured/Collected stay cross-cut so legacy moments
  // remain visible in user-history surfaces.
  if (scope === 'standalone' && !singleCollection) {
    const createdMints = await getCreatedMintsSet()
    merged = merged.filter((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return createdMints.has(`${moment.address?.toLowerCase()}:${moment.token_id}`)
    })
  }

  // Stitch KV moment-meta override onto merged moments. mint-proxy
  // writes the actual minter EOA at mint time; inprocess attributes
  // by the collection's defaultAdmin which is wrong for delegated
  // mints (anyone authorized via the "Authorize creators" panel).
  // Without this override, delegated mints surface on the deployer's
  // profile + cards instead of the actual minter's. Same trust path
  // MomentDetailView already uses via the kvCreatorAddress fallback.
  // One MGET in place of N parallel GETs — same shape out, single round trip.
  const metas = await getMomentMetaBatch(
    merged.map((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return { address: moment.address, tokenId: moment.token_id }
    }),
  )
  merged = merged.map((m: unknown, i: number) => {
    const meta = metas[i]
    if (!meta?.creator) return m
    const moment = m as {
      creator?: { address?: string; username?: string | null }
    }
    if (
      moment.creator?.address?.toLowerCase() === meta.creator.toLowerCase()
    ) {
      // Inprocess already had the right creator — preserve any
      // username it surfaced so we don't strip it.
      return m
    }
    // Override the address; clear the username so the client falls
    // back to fetchCreatorProfile and resolves the right one.
    return {
      ...moment,
      creator: { address: meta.creator, username: null },
    }
  })

  // Creator filter (Featured / Profile feeds). Matches if the moment's
  // creator address is *any* address in the expanded FID sibling set.
  if (creatorSet) {
    merged = merged.filter((m: unknown) => {
      const moment = m as { creator?: { address?: string } }
      const addr = moment.creator?.address?.toLowerCase()
      return addr ? creatorSet.has(addr) : false
    })
  }

  // Airdroppable filter — moments this address has admin authority over.
  // Inprocess populates `admins[]` from on-chain ADMIN holders at each
  // moment's tokenId, so delegated admins appear here even though they
  // aren't the creator. Match on either `creator.address` or any entry
  // in `admins[]` so the creator's own moments still surface (some
  // inprocess responses don't include the creator in admins[] when they
  // hold the bit only via tokenId 0).
  if (airdroppable) {
    merged = merged.filter((m: unknown) => {
      const moment = m as {
        creator?: { address?: string }
        admins?: { address?: string }[]
      }
      if (moment.creator?.address?.toLowerCase() === airdroppable) return true
      return (
        moment.admins?.some(
          (a) => a.address?.toLowerCase() === airdroppable,
        ) ?? false
      )
    })
  }

  // Collector filter — returns only moments this address (or any sibling
  // verified address of the same FID) has collected through the app.
  // The unioned collectedSet was built at the top of the handler from
  // each sibling's zset.
  if (collectorSet && collectedSet) {
    const setRef = collectedSet
    merged = merged.filter((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return setRef.has(`${moment.address?.toLowerCase()}:${moment.token_id}`)
    })
  }

  if (featured) {
    // Fetch featured set (member = "collectionAddress:tokenId", score = featuredAt timestamp)
    const raw = (await redis.zrange(FEATURED_KEY, 0, -1, {
      rev: true,
      withScores: true,
    })) as (string | number)[]

    const featuredMap = new Map<string, number>()
    for (let i = 0; i + 1 < raw.length; i += 2) {
      featuredMap.set(String(raw[i]), Number(raw[i + 1]))
    }

    merged = merged.filter((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return featuredMap.has(`${moment.address?.toLowerCase()}:${moment.token_id}`)
    })

    merged = merged.sort((a: unknown, b: unknown) => {
      const ma = a as { address?: string; token_id?: string }
      const mb = b as { address?: string; token_id?: string }
      const scoreA = featuredMap.get(`${ma.address?.toLowerCase()}:${ma.token_id}`) ?? 0
      const scoreB = featuredMap.get(`${mb.address?.toLowerCase()}:${mb.token_id}`) ?? 0
      return scoreB - scoreA
    })
  } else if (sort === 'trending') {
    // Fetch top trending scores in one call (flat alternating member/score array).
    // Capped at top 10k so the zset's lifetime growth doesn't bloat this read
    // (every collect is an unbounded ZINCRBY). Moments past the cap fall back
    // to score 0 via scoreMap.get's undefined → 0 coalesce below, putting them
    // at the bottom of trending sort — same effective ordering as fetching all.
    const raw = (await redis.zrange(TRENDING_KEY, 0, 9999, {
      rev: true,
      withScores: true,
    })) as (string | number)[]

    const scoreMap = new Map<string, number>()
    for (let i = 0; i + 1 < raw.length; i += 2) {
      scoreMap.set(String(raw[i]), Number(raw[i + 1]))
    }

    merged = merged.sort((a: unknown, b: unknown) => {
      const ma = a as { address?: string; token_id?: string; created_at: string }
      const mb = b as { address?: string; token_id?: string; created_at: string }
      const scoreA = scoreMap.get(`${ma.address?.toLowerCase()}:${ma.token_id}`) ?? 0
      const scoreB = scoreMap.get(`${mb.address?.toLowerCase()}:${mb.token_id}`) ?? 0
      if (scoreB !== scoreA) return scoreB - scoreA
      return new Date(mb.created_at).getTime() - new Date(ma.created_at).getTime()
    })
  } else {
    // Default: newest first
    merged = merged.sort((a: unknown, b: unknown) => {
      const ma = a as { created_at: string }
      const mb = b as { created_at: string }
      return new Date(mb.created_at).getTime() - new Date(ma.created_at).getTime()
    })
  }

  // Hide creator-hidden moments AND moments inside hidden collections. On a
  // creator's own profile feed (?creator=<their address>) they can still
  // see their own hidden moments so they can navigate to the detail page
  // and unhide. Everywhere else (main feed, trending, collection view,
  // someone else's profile) hidden means hidden for everyone including the
  // creator themselves.
  //
  // Collection-level hides cascade at read time: every moment whose parent
  // collection is in hidden-collections is filtered exactly the same way as
  // an individually-hidden moment. This means (a) newly-minted moments in
  // a hidden collection are automatically hidden, and (b) unhiding the
  // collection restores everything that wasn't separately marked
  // moment-hidden — no bulk write needed.
  const [hiddenSet, hiddenColls, hiddenUsers, viewer] = await Promise.all([
    getHiddenMomentsSet(),
    getHiddenCollectionsSet(),
    getHiddenUsersSet(),
    getSessionAddress(req),
  ])
  if (hiddenSet.size > 0 || hiddenColls.size > 0 || hiddenUsers.size > 0) {
    const viewerLower = viewer?.toLowerCase() ?? null
    // "Own profile" = the viewer is one of the sibling verified addresses
    // of the queried creator FID, so they can see their own hidden moments
    // from any of their wallets.
    const isOwnProfile =
      viewerLower !== null && !!creatorSet && creatorSet.has(viewerLower)
    merged = merged
      .filter((m: unknown) => {
        const moment = m as { address?: string; token_id?: string; creator?: { address?: string } }
        const addr = moment.address?.toLowerCase() ?? ''
        const creatorAddr = moment.creator?.address?.toLowerCase() ?? ''
        const key = `${addr}:${moment.token_id}`
        // Hidden-user filter: drop content from admin-hidden creators
        // EXCEPT when the viewer is the creator themselves on their own
        // profile. Same "creator sees their own hidden content"
        // exception as the per-content hide above — the hide is from
        // PUBLIC feeds, the user themselves can still see what's there.
        if (hiddenUsers.has(creatorAddr)) {
          if (!(isOwnProfile && creatorAddr === viewerLower)) return false
        }
        const isHidden = hiddenSet.has(key) || hiddenColls.has(addr)
        if (!isHidden) return true
        return isOwnProfile && creatorAddr === viewerLower
      })
      .map((m: unknown) => {
        const moment = m as { address?: string; token_id?: string }
        const addr = moment.address?.toLowerCase() ?? ''
        const key = `${addr}:${moment.token_id}`
        if (hiddenSet.has(key) || hiddenColls.has(addr)) return { ...(m as object), hidden: true }
        return m
      })
  }

  // Following priority: bubble followed creators to the top, preserve internal order
  if (followingSet && followingSet.size > 0) {
    const followed = merged.filter((m: unknown) => {
      const moment = m as { creator?: { address?: string } }
      return followingSet.has(moment.creator?.address?.toLowerCase() ?? '')
    })
    const rest = merged.filter((m: unknown) => {
      const moment = m as { creator?: { address?: string } }
      return !followingSet.has(moment.creator?.address?.toLowerCase() ?? '')
    })
    merged = [...followed, ...rest]
  }

  const start = (page - 1) * limit
  const total_pages = Math.max(1, Math.ceil(merged.length / limit))

  // Enrich only the page slice — keeps the MGET cost proportional to
  // what the client will render.
  const moments = await enrichMomentsWithKismetMeta(
    merged.slice(start, start + limit) as Moment[],
  )

  // Note: an earlier version of this route stitched saleConfig into
  // each moment server-side (one fan-out fetch to inprocess /moment
  // per returned moment) to eliminate the per-card client fetch in
  // MomentCard. Reverted because the cold-cache server latency
  // (~1-2s for the slowest of 20 parallel calls) stacked onto JS
  // parse + hydration on slow mobile CPUs and was producing 5-10s
  // perceived first-open times. MomentCard's per-card /api/moment
  // fetch path is the canonical price-loading path again — it runs
  // async after the card mounts, so it doesn't block the main thread
  // (cards still render with un-set price state and fill in as
  // fetches resolve, which is the "popcorn" UX users tolerate well
  // when measured against full-feed wait).

  // Visibility for "empty feed" reports — lets us tell at a glance whether
  // the issue is fan-out (no tracked collections), upstream (inprocess
  // returned nothing), or filtering (over-eager scope/hide/creator).
  if (moments.length === 0) {
    console.log('[timeline] empty', {
      scope, collections: collections.length,
      mergedBeforeFilter: results.flat().length, mergedAfterFilter: merged.length,
      filters: {
        creator: creatorRaw,
        creatorSiblings: creatorAddrs?.length ?? 0,
        collector: collectorRaw,
        collectorSiblings: collectorAddrs?.length ?? 0,
        airdroppable, featured, sort, filterToCreators, hasFollowing: !!followingSet?.size,
      },
    })
  }

  return NextResponse.json(
    { status: 'success', moments, pagination: { page, limit, total_pages } },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
