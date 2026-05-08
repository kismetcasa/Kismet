import { NextRequest, NextResponse } from 'next/server'
import { getTrackedCollectionsByScope, type CollectionScope } from '@/lib/kv'
import { INPROCESS_API } from '@/lib/inprocess'
import { redis, FEATURED_KEY } from '@/lib/redis'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getSessionAddress } from '@/lib/session'

async function fetchCollection(collection: string, limit: number): Promise<unknown[]> {
  const url = new URL(`${INPROCESS_API}/timeline`)
  url.searchParams.set('collection', collection)
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('chain_id', '8453')
  try {
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, next: { revalidate: 30 } })
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
  const creator = searchParams.get('creator')?.toLowerCase() ?? undefined
  const collector = searchParams.get('collector')?.toLowerCase() ?? undefined
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

  // standalone = PLATFORM + auto-deploy wrappers; collections = curated
  // (user-deployed) only; all = unfiltered. Mints feed uses standalone
  // so collection moments don't double up across sub-tabs.
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

  const collections = singleCollection
    ? [singleCollection]
    : await getTrackedCollectionsByScope(scope)

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

  // Creator filter (Featured / Profile feeds)
  if (creator) {
    merged = merged.filter((m: unknown) => {
      const moment = m as { creator?: { address?: string } }
      return moment.creator?.address?.toLowerCase() === creator
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

  // Collector filter — returns only moments this address has collected through the app
  if (collector) {
    const pairs = (await redis.zrange(`kismetart:collected:${collector}`, 0, -1, { rev: true })) as string[]
    const collectedSet = new Set(pairs)
    merged = merged.filter((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return collectedSet.has(`${moment.address?.toLowerCase()}:${moment.token_id}`)
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
    // Fetch all trending scores from Redis in one call (flat alternating member/score array)
    const raw = (await redis.zrange('kismetart:trending', 0, -1, {
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

  // Hide creator-hidden moments. On a creator's own profile feed
  // (?creator=<their address>) they can still see their own hidden moments
  // so they can navigate to the detail page and unhide. Everywhere else
  // (main feed, trending, collection view, someone else's profile) hidden
  // means hidden for everyone including the creator themselves.
  const [hiddenSet, viewer] = await Promise.all([
    getHiddenMomentsSet(),
    getSessionAddress(req),
  ])
  if (hiddenSet.size > 0) {
    const viewerLower = viewer?.toLowerCase() ?? null
    const isOwnProfile = viewerLower !== null && creator === viewerLower
    merged = merged
      .filter((m: unknown) => {
        const moment = m as { address?: string; token_id?: string; creator?: { address?: string } }
        const key = `${moment.address?.toLowerCase()}:${moment.token_id}`
        if (!hiddenSet.has(key)) return true
        return isOwnProfile && moment.creator?.address?.toLowerCase() === viewerLower
      })
      .map((m: unknown) => {
        const moment = m as { address?: string; token_id?: string }
        const key = `${moment.address?.toLowerCase()}:${moment.token_id}`
        if (hiddenSet.has(key)) return { ...(m as object), hidden: true }
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
  const moments = merged.slice(start, start + limit)
  const total_pages = Math.max(1, Math.ceil(merged.length / limit))

  // Visibility for "empty feed" reports — lets us tell at a glance whether
  // the issue is fan-out (no tracked collections), upstream (inprocess
  // returned nothing), or filtering (over-eager scope/hide/creator).
  if (moments.length === 0) {
    console.log('[timeline] empty', {
      scope, collections: collections.length,
      mergedBeforeFilter: results.flat().length, mergedAfterFilter: merged.length,
      filters: { creator, collector, airdroppable, featured, sort, filterToCreators, hasFollowing: !!followingSet?.size },
    })
  }

  return NextResponse.json({
    status: 'success',
    moments,
    pagination: { page, limit, total_pages },
  })
}
