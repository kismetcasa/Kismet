import { NextRequest, NextResponse, after } from 'next/server'
import { type Address } from 'viem'
import { runDropCoordination } from '@/lib/agent/scout/dropCoordinator'
import { SITE_URL } from '@/lib/siteUrl'
import { isAddress } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import { PLATFORM_COLLECTION } from '@/lib/config'
import {
  getTrackedCollections,
  getUserCollections,
  addTrackedCollection,
  getCollectionsByArtist,
  getCollectionMeta,
  getCollectionMetaBatch,
  markCreatedMint,
  type CollectionSource,
} from '@/lib/kv'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { setMomentMeta } from '@/lib/notifications'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'
import { getHiddenMomentsSet } from '@/lib/hiddenMoments'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { fetchEligibleTokens } from '@/lib/saleConfig'
import { consumeUserQuota } from '@/lib/userQuota'
import { errorResponse } from '@/lib/apiResponse'

// Cap on tokens we fetch per collection when computing bulk-collect
// eligibility for the feed. Aligned with MAX_COLLECT_ALL_BATCH (20) since
// eligible IDs beyond that get truncated at click time anyway.
const FEED_ELIGIBLE_TOKEN_LIMIT = 20

// Fetch the rich collection record from inprocess, falling back to local KV
// when the indexer hasn't yet picked up a freshly-deployed collection.
async function loadCollectionMeta(address: string): Promise<Record<string, unknown>> {
  try {
    const url = inprocessUrl('/collection', { collectionAddress: address, chainId: '8453' })
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (res.ok) {
      const text = await res.text()
      if (text) {
        const data: unknown = JSON.parse(text)
        // inprocess returns null pre-index; fall through to KV.
        if (
          data &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          Object.keys(data).length > 0
        ) {
          return { ...(data as Record<string, unknown>), contractAddress: address }
        }
      }
    }
  } catch {
    // fall through to KV fallback below
  }
  const kv = await getCollectionMeta(address)
  return {
    contractAddress: address,
    name: kv?.name,
    metadata: kv
      ? {
          name: kv.name,
          image: kv.image,
          description: kv.description,
          // Pass through thumbhash so the MintForm collection chip + any
          // other client surfaces get the blur placeholder during image
          // load. inprocess passes it through when it indexes the
          // Arweave metadata JSON; the KV fallback was dropping it.
          ...(kv.kismet_thumbhash ? { kismet_thumbhash: kv.kismet_thumbhash } : {}),
        }
      : undefined,
  }
}

interface CollectAllEligibility {
  ethEligibleTokenIds: string[]
  ethEligibleTotalWei: string
  usdcEligibleTokenIds: string[]
  usdcEligibleTotalUsdc: string
}

// Resolve ETH- and USDC-eligible token IDs + totals for a collection so the
// card can render a one-click "collect all" CTA. Returns empty fields on
// any failure — the action component then hides itself.
async function loadCollectAllEligibility(
  client: ReturnType<typeof serverBaseClient>,
  address: string,
  hiddenMoments: Set<string>,
): Promise<CollectAllEligibility> {
  const empty: CollectAllEligibility = {
    ethEligibleTokenIds: [],
    ethEligibleTotalWei: '0',
    usdcEligibleTokenIds: [],
    usdcEligibleTotalUsdc: '0',
  }
  try {
    const tlUrl = inprocessUrl('/timeline', {
      collection: address,
      limit: FEED_ELIGIBLE_TOKEN_LIMIT,
      chain_id: '8453',
    })
    const tlRes = await fetch(tlUrl, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    if (!tlRes.ok) return empty
    const tlData = (await tlRes.json()) as { moments?: { address?: string; token_id?: string }[] }
    const moments = Array.isArray(tlData.moments) ? tlData.moments : []
    const lowerAddr = address.toLowerCase()
    // Strip individually-hidden moments so we don't bundle them into the
    // multicall — minting a hidden token from the feed would be surprising.
    const visibleIds = moments
      .filter((m) => m.token_id && !hiddenMoments.has(`${(m.address ?? lowerAddr).toLowerCase()}:${m.token_id}`))
      .map((m) => BigInt(m.token_id as string))
    if (visibleIds.length === 0) return empty
    const [ethEligible, usdcEligible] = await Promise.all([
      fetchEligibleTokens(client, address as Address, visibleIds, 'eth'),
      fetchEligibleTokens(client, address as Address, visibleIds, 'usdc'),
    ])
    return {
      ethEligibleTokenIds: ethEligible.map((e) => e.tokenId.toString()),
      ethEligibleTotalWei: ethEligible
        .reduce((sum, e) => sum + e.pricePerToken, 0n)
        .toString(),
      usdcEligibleTokenIds: usdcEligible.map((e) => e.tokenId.toString()),
      usdcEligibleTotalUsdc: usdcEligible
        .reduce((sum, e) => sum + e.pricePerToken, 0n)
        .toString(),
    }
  } catch {
    return empty
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist')
  const feed = searchParams.get('feed')
  const singleAddress = searchParams.get('address')

  // Single-collection lookup for MomentDetailView's collection chip.
  // Returns the rich shape only for curated collections; standalone /
  // auto-deploy / unknown contracts get a minimal stub so they don't
  // render a header.
  if (singleAddress) {
    if (!isAddress(singleAddress)) {
      return errorResponse(400, 'Invalid address')
    }
    const lowerAddr = singleAddress.toLowerCase()
    const platformLower = PLATFORM_COLLECTION.toLowerCase()
    if (lowerAddr === platformLower) {
      return NextResponse.json({ contractAddress: singleAddress })
    }
    const [userCreated, hiddenSet] = await Promise.all([
      getUserCollections(),
      getHiddenCollectionsSet(),
    ])
    if (!userCreated.some((a) => a.toLowerCase() === lowerAddr) || hiddenSet.has(lowerAddr)) {
      return NextResponse.json({ contractAddress: singleAddress })
    }
    try {
      const url = inprocessUrl('/collection', { collectionAddress: singleAddress, chainId: '8453' })
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        next: { revalidate: 120 },
      })
      if (res.ok) {
        const text = await res.text()
        if (text) {
          const data = JSON.parse(text) as Record<string, unknown>
          if (data && typeof data === 'object' && Object.keys(data).length > 0) {
            return NextResponse.json({ contractAddress: singleAddress, ...data })
          }
        }
      }
    } catch {
      // fall through to KV
    }
    const kv = await getCollectionMeta(singleAddress)
    return NextResponse.json({
      contractAddress: singleAddress,
      name: kv?.name,
      metadata: kv ? { name: kv.name, image: kv.image } : undefined,
    })
  }

  // Discovery feed: hydrate each curated address from inprocess
  // /api/collection (KV fallback on indexer lag), sort by `created_at`
  // desc. Same membership-then-sort split as the Mints feed in
  // app/api/timeline/route.ts. Proxying inprocess's global collections
  // endpoint instead would surface collections we didn't deploy.
  if (feed) {
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '18', 10) || 18))
    const [userCreated, hiddenSet, hiddenMoments, hiddenUsers] = await Promise.all([
      getUserCollections(),
      getHiddenCollectionsSet(),
      getHiddenMomentsSet(),
      getHiddenUsersSet(),
    ])
    // Cascade the hidden-users filter onto the discovery feed by looking
    // up each tracked collection's deployer (stored in KV's artist field)
    // and dropping any whose artist is on the hidden-users list. Single
    // MGET via getCollectionMetaBatch — same cost as a single Redis call,
    // not per-collection. Auto-deploy wrappers without a stored meta
    // entry are kept (artist unknown ≠ hidden).
    const metaByAddr = hiddenUsers.size > 0
      ? await getCollectionMetaBatch(userCreated)
      : new Map<string, { artist?: string }>()
    const visible = userCreated.filter((addr) => {
      const lower = addr.toLowerCase()
      if (hiddenSet.has(lower)) return false
      if (hiddenUsers.size > 0) {
        const artist = metaByAddr.get(lower)?.artist?.toLowerCase()
        if (artist && hiddenUsers.has(artist)) return false
      }
      return true
    })
    const total = visible.length
    const total_pages = Math.max(1, Math.ceil(total / limit))
    const client = serverBaseClient()
    const hydrated = await Promise.all(
      visible.map(async (address) => {
        // Hydrate metadata + bulk-collect eligibility in parallel. Mirrors
        // /api/featured/collections-hydrated so the discovery grid surfaces
        // the same one-click "collect all" UX as the featured rows.
        const [metaPart, eligibility] = await Promise.all([
          loadCollectionMeta(address),
          loadCollectAllEligibility(client, address, hiddenMoments),
        ])
        return { ...metaPart, ...eligibility }
      }),
    )
    // Indexer-lagging deploys have no `created_at` (KV fallback shape) —
    // Infinity sorts them above any indexed entry, so a just-created
    // collection lands at the top of the feed while inprocess catches up.
    hydrated.sort((a, b) => {
      const aRaw = (a as { created_at?: string }).created_at
      const bRaw = (b as { created_at?: string }).created_at
      const aTs = aRaw ? new Date(aRaw).getTime() : Number.POSITIVE_INFINITY
      const bTs = bRaw ? new Date(bRaw).getTime() : Number.POSITIVE_INFINITY
      return bTs - aTs
    })
    const start = (page - 1) * limit
    const collections = hydrated.slice(start, start + limit)
    // Visibility for "empty feed" reports — distinguishes "nothing tracked
    // yet" from "tracked but inprocess+KV both returned nothing".
    if (collections.length === 0) {
      console.log('[collections feed] empty', {
        userCreated: userCreated.length, hidden: hiddenSet.size, visible: visible.length,
      })
    }
    return NextResponse.json({
      collections,
      pagination: { page, limit, total, total_pages },
    })
  }

  if (artist) {
    if (!isAddress(artist)) {
      return errorResponse(400, 'Invalid artist address')
    }
    const artistLower = artist.toLowerCase()
    // Hoist session + hidden-users gate above try/catch so both the
    // happy path and the inprocess-down fallback share the same viewer
    // identity and admin-hide check (and getSessionAddress's JWT verify
    // only runs once per request). Same own-profile exception as the
    // per-content hide system.
    const [viewer, hiddenUsers] = await Promise.all([
      getSessionAddress(req),
      getHiddenUsersSet(),
    ])
    const isOwnProfile = viewer?.toLowerCase() === artistLower
    if (hiddenUsers.has(artistLower) && !isOwnProfile) {
      return NextResponse.json({ collections: [] }, {
        headers: { 'Cache-Control': 'private, no-store' },
      })
    }
    const url = inprocessUrl('/collections', { artist, limit: 100 })
    try {
      const [res, userCreated, kvOwned, hiddenSet] = await Promise.all([
        fetch(url, {
          headers: { Accept: 'application/json' },
          next: { revalidate: 120 },
        }),
        getUserCollections(),
        getCollectionsByArtist(artist),
        getHiddenCollectionsSet(),
      ])
      const text = await res.text()
      const data = JSON.parse(text)
      // Filter to curated only — auto-deploy wrappers go in Mints feed.
      const userSet = new Set(userCreated.map((a: string) => a.toLowerCase()))
      const inprocessAddrs = new Set<string>()
      if (Array.isArray(data.collections)) {
        data.collections = data.collections.filter(
          (c: { contractAddress?: string }) => {
            if (!c.contractAddress) return false
            const lower = c.contractAddress.toLowerCase()
            if (!userSet.has(lower)) return false
            inprocessAddrs.add(lower)
            return isOwnProfile || !hiddenSet.has(lower)
          }
        )
      } else {
        data.collections = []
      }
      // KV fallback for collections the indexer hasn't picked up yet.
      for (const meta of kvOwned) {
        const lower = meta.address.toLowerCase()
        if (inprocessAddrs.has(lower)) continue
        if (!isOwnProfile && hiddenSet.has(lower)) continue
        data.collections.push({
          contractAddress: meta.address,
          name: meta.name,
          metadata: {
            name: meta.name,
            image: meta.image,
            description: meta.description,
          },
        })
      }
      return NextResponse.json(data, {
        status: res.status,
        headers: { 'Cache-Control': 'private, no-store' },
      })
    } catch {
      // Inprocess down — fall back to local KV only. viewer + isOwnProfile
      // are already in scope from the gate hoist above.
      const [kvOwned, hiddenSet] = await Promise.all([
        getCollectionsByArtist(artist),
        getHiddenCollectionsSet(),
      ])
      return NextResponse.json(
        {
          collections: kvOwned
            .filter((meta) => isOwnProfile || !hiddenSet.has(meta.address.toLowerCase()))
            .map((meta) => ({
              contractAddress: meta.address,
              name: meta.name,
              metadata: {
                name: meta.name,
                image: meta.image,
                description: meta.description,
              },
            })),
        },
        { headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
  }

  const collections = await getTrackedCollections()
  return NextResponse.json({ collections })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`collections:${ip}`, 5, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  // Authenticated caller — Kismet session cookie required.
  const sessionAddress = await getSessionAddress(req)
  if (!sessionAddress) {
    return errorResponse(401, 'Sign in to continue')
  }

  let body: {
    address: string
    name?: string
    image?: string
    description?: string
    artist?: string
    // 'auto-deploy' marks MintForm's first-mint wrappers; default
    // 'create-form' is the explicit Create Collection flow.
    source?: CollectionSource
    // tokenId minted as the collection's cover (Create Collection form
    // only). Marked as a created-mint so it surfaces in the Mints feed.
    coverTokenId?: string
    // Base64 thumbhash for the cover — surfaced as blurDataURL on the
    // collection page before the Arweave metadata fetch lands.
    kismet_thumbhash?: string
  }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'valid address required')
  }
  // Caller must claim themselves as the artist (no spoofing).
  if (!body.artist || body.artist.toLowerCase() !== sessionAddress) {
    return errorResponse(403, 'artist must match session address')
  }

  // Caller must hold ADMIN on chain (tokenId 0 = collection-wide row).
  // Outer retry rides out RPC propagation lag for fresh deploys —
  // readPermissions retries on throw, this loop retries on a definitive
  // perms=0 read since the deploy tx may have landed but a slow replica
  // hasn't synced yet.
  const client = serverBaseClient()
  let isAdmin = false
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const perms = await readPermissions(
        client,
        body.address as Address,
        0n,
        sessionAddress as Address,
        { retries: 1 },
      )
      if (hasAdminBit(perms)) {
        isAdmin = true
        break
      }
      lastErr = new Error(`perms=${perms} missing ADMIN bit`)
    } catch (err) {
      lastErr = err
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
    }
  }
  if (!isAdmin) {
    console.error('[collections POST] admin check failed', {
      address: body.address,
      caller: sessionAddress,
      err: lastErr instanceof Error ? lastErr.message : String(lastErr),
    })
    return errorResponse(502, 'Could not verify collection admin on-chain')
  }

  const source: CollectionSource = body.source === 'auto-deploy' ? 'auto-deploy' : 'create-form'

  // Per-address daily cap on DELIBERATE collection creation (Create
  // Collection form). Debited after the on-chain admin check so only a
  // legitimate deployer counts. auto-deploy wrappers are exempt: they're a
  // side effect of minting (already bounded by the mint cap) and gating them
  // here would 429 a mint mid-flow. Admin bypasses inside consumeUserQuota.
  if (source === 'create-form') {
    const withinQuota = await consumeUserQuota('collection', sessionAddress, 1)
    if (!withinQuota) {
      return errorResponse(429, 'Daily collection limit reached — try again tomorrow')
    }
  }
  await addTrackedCollection(
    body.address,
    {
      name: body.name ?? body.address,
      image: body.image,
      description: body.description,
      artist: sessionAddress,
      ...(body.kismet_thumbhash ? { kismet_thumbhash: body.kismet_thumbhash } : {}),
      // Persist so the featured-collection row can dedupe this token
      // from its mint-card grid without inferring it every request.
      ...(body.coverTokenId && /^\d+$/.test(body.coverTokenId)
        ? { coverTokenId: body.coverTokenId }
        : {}),
    },
    source,
  )
  // Cover tokens minted at deploy time (cover-mint toggle on) ARE
  // mints — they should show in the Mints feed alongside MintForm
  // mints. Track them in created-mints + write the per-moment KV
  // creator record so the timeline route's KV stitching can override
  // the wrong inprocess-attributed creator (deploy goes through the
  // factory, which inprocess returns as creator.address for the cover
  // token — without this override the cover mint shows up under the
  // factory address and disappears from any creator-filtered feed).
  // Mirrors the post-mint hooks in lib/mint-proxy.ts.
  if (source === 'create-form' && body.coverTokenId && /^\d+$/.test(body.coverTokenId)) {
    const coverTokenId = body.coverTokenId
    await Promise.all([
      markCreatedMint(body.address, coverTokenId),
      setMomentMeta(body.address, coverTokenId, {
        creator: sessionAddress,
        name: body.name ?? body.address,
      }),
    ])
    // Phase 3 — a new collection's cover IS a drop; fan it out to agents
    // watching this artist (round-robin, within each budget). Post-response,
    // best-effort, self-gating (no-op without watchers / a configured spender).
    after(() =>
      runDropCoordination({ collection: body.address, tokenId: coverTokenId, creator: sessionAddress }, SITE_URL).catch(
        () => {},
      ),
    )
  }
  return NextResponse.json({ ok: true })
}
