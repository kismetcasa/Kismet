import { NextRequest, NextResponse } from 'next/server'
import { getTrackedCollectionsByScope, getCreatedMintsMembership, type CollectionScope } from '@/lib/kv'
import { inprocessUrl } from '@/lib/inprocess'
import { redis, zpairsToMap, FEATURED_KEY, TRENDING_KEY, TRENDING_LATEST_KEY, MAX_FEATURED } from '@/lib/redis'
import { getUpcomingSaleEnds, getFreeMoments } from '@/lib/saleEnds'
import { getCollectedMembers } from '@/lib/collected'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getSessionAddress } from '@/lib/session'
import { getMomentMetaBatch } from '@/lib/notifications'
import { resolveMomentCreator } from '@/lib/statsMath'
import { expandToFidSiblings } from '@/lib/addressUnion'
import { enrichMomentsWithKismetMeta } from '@/lib/momentEnrichment'
import type { Moment } from '@/lib/inprocess'
import { synthesizeMissingCoverMoment } from '@/lib/coverMomentSynthesis'
import { getRecipientSplits } from '@/lib/splits'
import { getDelegatedMoments } from '@/lib/airdropDelegates'
import { serverBaseClient } from '@/lib/rpc'
import { hasAdminBit, hasMinterBit, readPermissions } from '@/lib/permissions'

// Bounded-concurrency map: cap how many inprocess /timeline fetches are in
// flight at once. A plain Promise.all over the full tracked-collection set
// opens one upstream socket per collection simultaneously; when inprocess
// (a single upstream dependency for all content) is slow, that pile-up
// exhausts sockets + in-flight parse buffers on the single box and saturates
// the event loop. A small concurrency window keeps the fan-out fast without
// unbounded simultaneous load. (SRE handling-overload / Azure Bulkhead.)
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker)
  await Promise.all(workers)
  return results
}

const FANOUT_CONCURRENCY = 10

// Throttle for the fan-out-thinning warning below — it fires on every request
// once the tracked set is large enough, and one line a minute is signal while
// one per request is noise.
let lastThinningWarnAt = 0

async function fetchCollection(collection: string, limit: number, fresh: boolean): Promise<unknown[]> {
  const url = inprocessUrl('/timeline', { collection, limit, chain_id: '8453' })
  let moments: unknown[] = []
  try {
    // Per-call timeout: inprocess is a single point of dependency, and without
    // an AbortSignal a hung upstream pins this handler (and its fan-out slot)
    // until Node's ~300s request timeout. 8s matches lib/inprocess.ts's
    // fetchCollectionMoments default. On timeout the catch degrades this
    // collection to [] rather than stalling the whole feed request.
    //
    // `fresh` is the manual-refresh path (client sends ?fresh=1): bypass the
    // per-pod revalidate window entirely so the refresh returns brand-new
    // mints instead of the ≤30s-cached copy. Default browsing keeps
    // revalidate:30 — the cache is what keeps the fan-out off the hot path.
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      ...(fresh ? { cache: 'no-store' as const } : { next: { revalidate: 30 } }),
      signal: AbortSignal.timeout(8_000),
    })
    const text = await res.text()
    const data = JSON.parse(text)
    moments = Array.isArray(data.moments) ? data.moments : []
  } catch {
    moments = []
  }

  // Cover-mints created at deploy time via factory setupAction never reach
  // inprocess's /moment/create endpoint, so they don't enter the /timeline
  // index even though they're on-chain and inprocess /moment resolves them.
  // Synthesize the missing entry locally, gated by collection-meta's
  // coverTokenId — only set by /api/collections POST for create-form deploys
  // with a cover mint, so case #1 (collection only) and case #3 (individual
  // MintForm mint via inprocess) are untouched. Failure short-circuits to
  // null so a synthesis error never poisons the inprocess passthrough.
  const synthCover = await synthesizeMissingCoverMoment(
    collection,
    moments as { token_id?: string }[],
  )
  if (synthCover) moments.push(synthCover)

  return moments
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  // page is capped: fetchLimit below is `page * limit`, sent verbatim as the
  // upstream /timeline `limit` for EVERY tracked collection in parallel. An
  // uncapped page (e.g. 1e8) would fan out billions-sized upstream requests —
  // a cheap-request → expensive-amplification DoS. 100 pages is far beyond any
  // real scroll (page 100 @ limit 20 = 2,000 items deep); beyond it the feed
  // degrades gracefully to empty rather than amplifying.
  const page = Math.min(100, Math.max(1, parseInt(searchParams.get('page') ?? '1') || 1))
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
  // Cross-collection sort mode. 'trending' = most sales (all-time collect
  // count, the original), 'latest-sales' = most recent collect first,
  // 'ending-soon' = live sale deadlines soonest-first. Unrecognized values
  // fall through to null (newest-first) instead of silently half-matching.
  const rawSort = searchParams.get('sort')
  const sort =
    rawSort === 'trending' || rawSort === 'latest-sales' || rawSort === 'ending-soon'
      ? rawSort
      : null
  const featured = searchParams.get('featured') === '1'
  // Manual-refresh signal (PaginatedGrid's refresh button). Bypasses the
  // upstream revalidate window AND the shared-response cache below so the
  // click reliably surfaces new mints; normal browsing never sets it.
  const fresh = searchParams.get('fresh') === '1'
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

  // Featured requests read the zset up front (reused by the filter/sort
  // below) so the fan-out can be narrowed to just the collections that
  // actually contain featured members.
  let featuredWithScores: (string | number)[] | null = null
  if (featured) {
    featuredWithScores = (await redis.zrange(FEATURED_KEY, 0, MAX_FEATURED - 1, {
      rev: true,
      withScores: true,
    })) as (string | number)[]
  }

  const trackedCollections = singleCollection
    ? [singleCollection]
    : await getTrackedCollectionsByScope(scope)

  // Narrow the fan-out when the post-merge filter makes most of it provably
  // wasted — this is both the load fix (a handful of upstream calls instead of
  // every tracked contract) and the completeness fix (per-collection depth is
  // budget/width, so a narrow width keeps deep samples and curated/collected
  // items can't fall outside a thinned sample):
  //  - featured=1 keeps only FEATURED_KEY members, so only the collections
  //    those members live in can contribute a surviving moment.
  //  - collector= keeps only collectedSet pairs, whose collections are by
  //    construction in collectedCollections.
  // Everything else keeps the tracked∪collected union so an airdrop into an
  // untracked collection still reaches the recipient's feed — the original
  // reason collectedCollections is merged in.
  let collections: string[]
  if (!singleCollection && featuredWithScores) {
    const fromFeatured = new Set<string>()
    for (let i = 0; i + 1 < featuredWithScores.length; i += 2) {
      const member = String(featuredWithScores[i])
      const colon = member.indexOf(':')
      if (colon > 0) fromFeatured.add(member.slice(0, colon).toLowerCase())
    }
    collections = Array.from(fromFeatured)
  } else if (!singleCollection && collectorSet && collectedSet) {
    collections = collectedCollections
  } else {
    collections = Array.from(new Set([...trackedCollections, ...collectedCollections]))
  }

  // Cross-collection sort, featured curation, and the creators allowlist
  // can each thin the result set below `page * limit`. Bump the per-
  // collection sample so paginated pages don't empty out prematurely.
  // All three sort modes reorder across collections (a recently-sold or
  // soon-ending moment can sit deep in its collection's newest-first
  // timeline), so they all need the deeper sample.
  const needsLargerSample = sort !== null || featured || filterToCreators
  const baseSample = needsLargerSample ? Math.max(page * limit, 200) : page * limit
  // Bound the TOTAL moments pulled into the in-memory merge, not just the
  // per-collection request. The fan-out hits EVERY collection in parallel and
  // holds the whole merged set in heap to sort before slicing `limit`; the
  // heap, the MGET stitch, and the O(n log n) sort all scale as
  // collections × fetchLimit and are the OOM vector on the single box.
  //
  // The budget MUST hold regardless of how many collections are tracked — the
  // tracked set grows with every deploy and is never pruned. An earlier
  // version floored the per-collection share at `limit` ("every collection can
  // fill a page"), which silently defeated the budget past
  // MERGE_BUDGET/limit collections: the merge became limit × N, unbounded in
  // N. The floor is now 1: past that width each collection's sample THINS
  // instead of the merge growing — degrade depth, never stability. The durable
  // fix is a materialized feed (SCALING.md §B1). A single
  // collection (N=1) is unchanged until page*limit exceeds the whole budget.
  // (SRE handling-overload / Azure Bulkhead.)
  //
  // Personal filtered feeds (creator= / airdroppable=) keep only one address's
  // moments out of the whole merge, so per-collection depth decides whether an
  // artist's older work surfaces on their own profile. Those requests get a 2×
  // budget: they are `private, no-store` low-QPS views and the doubled
  // transient merge stays hard-bounded. Collector feeds don't need it — their
  // fan-out is already narrowed to collectedCollections above.
  const MERGE_BUDGET = creatorRaw || airdroppable ? 10_000 : 5_000
  // Absolute width ceiling: past MERGE_BUDGET collections even 1 moment per
  // collection breaches the budget, and the wall-clock of that many upstream
  // calls (FANOUT_CONCURRENCY at a time, 8s worst case each) is its own
  // outage. Deterministic subset (sorted) + error log — an explicit degraded
  // mode, never a silent one. If this ever fires, the materialized feed is
  // overdue.
  if (collections.length > MERGE_BUDGET) {
    console.error('[timeline] fan-out width exceeds MERGE_BUDGET — truncating', {
      collections: collections.length,
      budget: MERGE_BUDGET,
    })
    collections = [...collections].sort().slice(0, MERGE_BUDGET)
  }
  const perCollectionCap = Math.max(1, Math.floor(MERGE_BUDGET / Math.max(1, collections.length)))
  const fetchLimit = Math.min(baseSample, perCollectionCap)
  if (perCollectionCap < limit && Date.now() - lastThinningWarnAt > 60_000) {
    lastThinningWarnAt = Date.now()
    console.warn('[timeline] fan-out thinned: tracked set exceeds MERGE_BUDGET/limit', {
      collections: collections.length,
      perCollectionCap,
      limit,
    })
  }
  const results = await mapWithConcurrency(collections, FANOUT_CONCURRENCY, (c) =>
    fetchCollection(c, fetchLimit, fresh),
  )

  // Merge and deduplicate
  const seen = new Set<string>()
  let merged = results.flat().filter((m: unknown) => {
    const moment = m as { id?: string }
    const key = moment.id ?? JSON.stringify(m)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // Stitch KV moment-meta override onto merged moments BEFORE any filter
  // that consumes creator.address. mint-proxy writes the actual minter EOA
  // at mint time, and /api/collections POST writes the artist EOA for the
  // cover-mint at deploy time; inprocess attributes both to the wrong
  // address (the collection's defaultAdmin for delegated mints, the factory
  // for cover-mints created via setupAction). Without the override, those
  // moments surface under the wrong address.
  //
  // Must run before filterToCreators (rosters) and the hidden-users filter:
  // both check creator.address, and a cover-mint or delegated mint would be
  // dropped under the wrong inprocess attribution before the stitch could
  // rescue it. creatorSet (profile) and airdroppable already run after this
  // block, so they consume the corrected value too. Same trust path
  // MomentDetailView uses via the kvCreatorAddress fallback.
  // One MGET in place of N parallel GETs — same shape out, single round trip.
  const metas = await getMomentMetaBatch(
    merged.map((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return { address: moment.address, tokenId: moment.token_id }
    }),
  )
  merged = merged.map((m: unknown, i: number) => {
    const meta = metas[i]
    if (!meta) return m
    const moment = m as {
      creator?: { address?: string; username?: string | null }
    }
    // Shared precedence (lib/statsMath resolveMomentCreator) — the same order
    // the stats rebuild uses to credit mints, so the feed and the earnings
    // card can't attribute a moment to different people. source === 'kv'
    // means the KV creator CHANGED the answer (an equal value reports 'feed',
    // so we never clobber a real username with null for a no-op rewrite).
    const resolved = resolveMomentCreator({
      kvCreator: meta.creator,
      feedCreator: moment.creator?.address,
    })
    const needsCreatorOverride = resolved.source === 'kv'
    const hasDuration =
      typeof meta.durationSec === 'number' && meta.durationSec > 0
    if (!needsCreatorOverride && !hasDuration) return m
    return {
      ...moment,
      ...(needsCreatorOverride
        ? { creator: { address: resolved.address as string, username: null } }
        : {}),
      // Surfaced for the client durationCache so InlineVideo can
      // skip the metadata→auto preload upgrade dance for long-form.
      ...(hasDuration ? { kismet_duration_sec: meta.durationSec } : {}),
    }
  })

  // Curated creator allowlist — narrows to moments by the listed creators.
  // Runs after the KV stitch above so cover-mints and delegated mints (which
  // inprocess attributes to the wrong address) match the roster on the
  // corrected creator.address, not the wrong factory/defaultAdmin one.
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
  //
  // Membership is checked via bounded SMISMEMBER over just this request's
  // merged candidates (getCreatedMintsMembership) — never a full SMEMBERS
  // of the ever-growing set, which would hard-fail at Upstash's 10MB
  // response cap past ~200k mints.
  //
  // If the membership lookup fails (Upstash blip), skip the filter for
  // this request rather than serve an empty feed. Showing some unfiltered
  // moments briefly is strictly better UX than "no moments yet" — and the
  // next request simply retries.
  if (scope === 'standalone' && !singleCollection) {
    try {
      const candidateKeys = merged.map((m: unknown) => {
        const moment = m as { address?: string; token_id?: string }
        return `${moment.address?.toLowerCase()}:${moment.token_id}`
      })
      const createdMints = await getCreatedMintsMembership(candidateKeys)
      merged = merged.filter((_m: unknown, i: number) => createdMints.has(candidateKeys[i]))
    } catch (err) {
      console.warn('[timeline] standalone filter skipped (Redis unavailable):', err)
    }
  }

  // Creator filter (Featured / Profile feeds). Matches if the moment's
  // creator address is *any* address in the expanded FID sibling set.
  if (creatorSet) {
    merged = merged.filter((m: unknown) => {
      const moment = m as { creator?: { address?: string } }
      const addr = moment.creator?.address?.toLowerCase()
      return addr ? creatorSet.has(addr) : false
    })
  }

  // Airdroppable filter — moments this address can mint an airdrop of.
  // Signals, cheapest first:
  //   1. creator.address === wallet — their own mint.
  //   2. wallet ∈ admins[] — inprocess indexes on-chain ADMIN holders at each
  //      moment's tokenId, so per-token ADMIN delegates surface here even
  //      though they aren't the creator.
  // Neither covers two real cases: (a) the Patron model attributes the moment
  // creator to the platform treasury and the artist holds ADMIN only via the
  // collection-wide tokenId-0 row, which inprocess's per-token admins[] omits;
  // (b) a per-piece MINTER delegate (kismetart.eth authorizing someone to
  // airdrop one piece at least privilege) — inprocess's admins[] is ADMIN-only
  // so a MINTER grant never appears there. adminMint would let both airdrop
  // (Zora ORs the tokenId-0 row into its gate and accepts ADMIN or MINTER).
  //   3. wallet is a split payee OR a recorded per-piece delegate on the
  //      moment, AND actually holds ADMIN/MINTER for it on-chain. Both
  //      candidate sets come from one reverse-index SMEMBERS each; authority
  //      is then confirmed exactly the way adminMint gates it —
  //      permissions[tokenId][wallet] | permissions[0][wallet], ADMIN|MINTER —
  //      so the picker keeps its invariant: it only lists pieces the airdrop
  //      tx can actually mint.
  if (airdroppable) {
    const wallet = airdroppable as `0x${string}`
    const cheapMatch = (m: unknown): boolean => {
      const moment = m as {
        creator?: { address?: string }
        admins?: { address?: string }[]
      }
      if (moment.creator?.address?.toLowerCase() === airdroppable) return true
      return (
        moment.admins?.some((a) => a.address?.toLowerCase() === airdroppable) ??
        false
      )
    }
    const momentKey = (m: unknown): string => {
      const moment = m as { address?: string; token_id?: string }
      return `${moment.address?.toLowerCase() ?? ''}:${moment.token_id ?? ''}`
    }

    // Candidate pieces: split payee (getRecipientSplits) ∪ per-piece delegate
    // (getDelegatedMoments). One SMEMBERS each, both empty for wallets with
    // neither — so this stays a no-op read for the common request.
    const [splitList, delegateList] = await Promise.all([
      getRecipientSplits(airdroppable).catch(() => []),
      getDelegatedMoments(airdroppable).catch(() => []),
    ])
    const candidateKeys = new Set<string>([
      ...splitList.map((s) => `${s.collection}:${s.tokenId}`),
      ...delegateList.map((d) => `${d.collection}:${d.tokenId}`),
    ])

    // Only candidates that appear in this merge and weren't already matched by
    // the cheap signals need an on-chain read.
    const toVerify: { collection: string; tokenId: string; key: string }[] = []
    if (candidateKeys.size > 0) {
      for (const m of merged) {
        if (cheapMatch(m)) continue
        const key = momentKey(m)
        if (!candidateKeys.has(key)) continue
        const mm = m as { address?: string; token_id?: string }
        const collection = mm.address?.toLowerCase()
        if (collection && mm.token_id != null) {
          toVerify.push({ collection, tokenId: String(mm.token_id), key })
        }
      }
    }

    // Confirm authority the way adminMint does: ADMIN|MINTER at the per-token
    // row OR the collection-wide tokenId-0 row. Read collection-wide once per
    // collection (promise-cached so concurrent workers don't double-read), and
    // fall through to the per-token row only when it doesn't already grant —
    // that covers collection-wide split artists in one read and per-piece
    // MINTER delegates in one more. Any read failure falls OPEN (keep the
    // candidate): the wallet is a named payee/delegate and adminMint
    // independently gates the real airdrop on-chain, so a transient RPC blip
    // shows an artist their own work rather than hiding it. Fail-open can never
    // enable an unauthorized airdrop; the chain is the gate, not this read.
    const authorizedKeys = new Set<string>()
    if (toVerify.length > 0) {
      const client = serverBaseClient()
      const collWide = new Map<string, Promise<bigint | null>>()
      const readCollWide = (collection: string): Promise<bigint | null> => {
        let p = collWide.get(collection)
        if (!p) {
          p = readPermissions(client, collection as `0x${string}`, 0n, wallet).catch(
            () => null,
          )
          collWide.set(collection, p)
        }
        return p
      }
      // Bounded concurrency (the same window the collection fan-out uses) so a
      // wallet delegated/paid across many pieces can't fire an unbounded burst
      // of eth_calls.
      await mapWithConcurrency(
        toVerify,
        FANOUT_CONCURRENCY,
        async ({ collection, tokenId, key }) => {
          const cw = await readCollWide(collection)
          if (cw === null) {
            authorizedKeys.add(key) // fail-open: collection-wide read failed
            return
          }
          if (hasAdminBit(cw) || hasMinterBit(cw)) {
            authorizedKeys.add(key)
            return
          }
          try {
            const pt = await readPermissions(
              client,
              collection as `0x${string}`,
              BigInt(tokenId),
              wallet,
            )
            if (hasAdminBit(pt) || hasMinterBit(pt)) authorizedKeys.add(key)
          } catch {
            authorizedKeys.add(key) // fail-open: per-token read failed
          }
        },
      )
    }

    merged = merged.filter((m: unknown) => {
      if (cheapMatch(m)) return true
      return authorizedKeys.has(momentKey(m))
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
    // Featured set (member = "collectionAddress:tokenId", score = featuredAt)
    // was read before the fan-out (it narrowed the collection list) — reuse it.
    const featuredMap = zpairsToMap(featuredWithScores ?? [])

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
  } else if (sort === 'trending' || sort === 'latest-sales') {
    // Fetch top scores in one call (flat alternating member/score array).
    // 'trending' scores by all-time collect count, 'latest-sales' by the
    // timestamp of the most recent collect — same zset shape, same 10k
    // write-side cap, so one read + one score-desc sort serves both.
    // Moments past the cap (or never collected) fall back to score 0 via
    // scoreMap.get's undefined → 0 coalesce below, putting them at the
    // bottom of the sort ordered newest-first by the created_at tiebreak.
    // The free-mint index rides the same round trip (auto-pipelined): these
    // are SALES feeds, so free mints (price 0) are dropped entirely — a free
    // mint is not a sale regardless of how many times it's been collected.
    const zsetKey = sort === 'trending' ? TRENDING_KEY : TRENDING_LATEST_KEY
    const [raw, freeSet] = await Promise.all([
      redis.zrange(zsetKey, 0, 9999, { rev: true, withScores: true }) as Promise<
        (string | number)[]
      >,
      getFreeMoments(),
    ])
    const scoreMap = zpairsToMap(raw)

    if (freeSet.size > 0) {
      merged = merged.filter((m: unknown) => {
        const moment = m as { address?: string; token_id?: string }
        return !freeSet.has(`${moment.address?.toLowerCase()}:${moment.token_id}`)
      })
    }

    merged = merged.sort((a: unknown, b: unknown) => {
      const ma = a as { address?: string; token_id?: string; created_at: string }
      const mb = b as { address?: string; token_id?: string; created_at: string }
      const scoreA = scoreMap.get(`${ma.address?.toLowerCase()}:${ma.token_id}`) ?? 0
      const scoreB = scoreMap.get(`${mb.address?.toLowerCase()}:${mb.token_id}`) ?? 0
      if (scoreB !== scoreA) return scoreB - scoreA
      return new Date(mb.created_at).getTime() - new Date(ma.created_at).getTime()
    })
  } else if (sort === 'ending-soon') {
    // Active window sales from the write-through index (lib/saleEnds.ts): the
    // index holds only moments whose sale has a real close date AND has already
    // started, and getUpcomingSaleEnds keeps only those whose close date is
    // still in the future — i.e. exactly "sales inside their window right now".
    // FILTER to that set (no padding with non-sale moments) and order soonest-
    // close first. Empty index (nothing active, or a Redis blip) → empty feed,
    // which is the honest result: there are no active timed sales to show.
    const endsMap = await getUpcomingSaleEnds(Math.floor(Date.now() / 1000))

    merged = merged.filter((m: unknown) => {
      const moment = m as { address?: string; token_id?: string }
      return endsMap.has(`${moment.address?.toLowerCase()}:${moment.token_id}`)
    })

    merged = merged.sort((a: unknown, b: unknown) => {
      const ma = a as { address?: string; token_id?: string; created_at: string }
      const mb = b as { address?: string; token_id?: string; created_at: string }
      // Every survivor has a real end after the filter; the created_at tiebreak
      // still orders sales that close at the same instant.
      const endA = endsMap.get(`${ma.address?.toLowerCase()}:${ma.token_id}`) ?? Infinity
      const endB = endsMap.get(`${mb.address?.toLowerCase()}:${mb.token_id}`) ?? Infinity
      if (endA !== endB) return endA - endB
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

  // Hidden-PROFILE (identity) NAME suppression is applied downstream in
  // enrichMomentsWithKismetMeta (the single creator-chip choke point), not
  // here: an earlier strip at this spot was silently re-populated by the
  // enrichment overlay that runs after it (username AND avatar). See
  // lib/momentEnrichment.ts.

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

  // Cache policy. A request is viewer-dependent — and therefore must never
  // be served from a shared cache — when it filters/reorders by who's asking:
  //   - creator=  : profile feed; the hidden-moment block below reveals the
  //                 OWNER's own hidden moments (isOwnProfile), so the body
  //                 differs for the creator vs everyone else.
  //   - collector= / airdroppable= : address-scoped personal feeds.
  //   - following= : reorders to bubble the caller's follows to the top.
  // Everything else (all sort modes — trending / latest-sales / ending-soon —
  // featured, the default newest feed, a single collection, the curated
  // creators= roster) is identical for every viewer:
  // the session cookie is read above but only consumed when creatorSet is set,
  // which none of these set. Those get a short shared-cache window with a
  // stale-while-revalidate tail so the first click on trending/main is served
  // from the edge in ~tens of ms and refreshed in the background, instead of
  // re-running the cross-collection fan-out + merge on every cold hit.
  const viewerDependent =
    !!creatorRaw || !!collectorRaw || !!airdroppable || !!followingParam
  const cacheControl =
    viewerDependent || fresh
      ? 'private, no-store'
      : 'public, s-maxage=30, stale-while-revalidate=120'

  return NextResponse.json(
    { status: 'success', moments, pagination: { page, limit, total_pages } },
    { headers: { 'Cache-Control': cacheControl } },
  )
}
