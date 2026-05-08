import { NextRequest, NextResponse } from 'next/server'
import { type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { serverBaseClient } from '@/lib/rpc'
import { PLATFORM_COLLECTION } from '@/lib/config'
import {
  getTrackedCollections,
  getUserCollections,
  addTrackedCollection,
  getCollectionsByArtist,
  getCollectionMeta,
  markCoverMoment,
  type CollectionSource,
} from '@/lib/kv'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'

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
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
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
      const url = new URL(`${INPROCESS_API}/collection`)
      url.searchParams.set('collectionAddress', singleAddress)
      url.searchParams.set('chainId', '8453')
      const res = await fetch(url.toString(), {
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

  // Discovery feed: enumerate curated collections, hydrate each from
  // inprocess /api/collection (KV fallback when the indexer is lagging).
  // Proxying inprocess's global feed instead would surface collections
  // we didn't deploy and miss our freshly-deployed ones.
  if (feed) {
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '18', 10) || 18))
    const [userCreated, hiddenSet] = await Promise.all([
      getUserCollections(),
      getHiddenCollectionsSet(),
    ])
    const visible = userCreated.filter(
      (addr) => !hiddenSet.has(addr.toLowerCase()),
    )
    const total = visible.length
    const total_pages = Math.max(1, Math.ceil(total / limit))
    const start = (page - 1) * limit
    const slice = visible.slice(start, start + limit)
    const collections = await Promise.all(
      slice.map(async (address) => {
        try {
          const url = new URL(`${INPROCESS_API}/collection`)
          url.searchParams.set('collectionAddress', address)
          url.searchParams.set('chainId', '8453')
          const res = await fetch(url.toString(), {
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
            ? { name: kv.name, image: kv.image, description: kv.description }
            : undefined,
        }
      }),
    )
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
      return NextResponse.json({ error: 'Invalid artist address' }, { status: 400 })
    }
    const url = new URL(`${INPROCESS_API}/collections`)
    url.searchParams.set('artist', artist)
    url.searchParams.set('limit', '100')
    try {
      const [res, userCreated, kvOwned, hiddenSet, viewer] = await Promise.all([
        fetch(url.toString(), {
          headers: { Accept: 'application/json' },
          next: { revalidate: 120 },
        }),
        getUserCollections(),
        getCollectionsByArtist(artist),
        getHiddenCollectionsSet(),
        getSessionAddress(req),
      ])
      const text = await res.text()
      const data = JSON.parse(text)
      // Filter to curated only — auto-deploy wrappers go in Mints feed.
      const userSet = new Set(userCreated.map((a: string) => a.toLowerCase()))
      // Artist sees their own hidden collections so they can unhide.
      const isOwnProfile = viewer?.toLowerCase() === artist.toLowerCase()
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
      return NextResponse.json(data, { status: res.status })
    } catch {
      // Inprocess down — fall back to local KV only.
      const [kvOwned, hiddenSet, viewer] = await Promise.all([
        getCollectionsByArtist(artist),
        getHiddenCollectionsSet(),
        getSessionAddress(req),
      ])
      const isOwnProfile = viewer?.toLowerCase() === artist.toLowerCase()
      return NextResponse.json({
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
      })
    }
  }

  const collections = await getTrackedCollections()
  return NextResponse.json({ collections })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`collections:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  // Authenticated caller — Kismet Art session cookie required.
  const sessionAddress = await getSessionAddress(req)
  if (!sessionAddress) {
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
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
    // only). Marked in cover-moments so it stays out of Mints feeds.
    coverTokenId?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 })
  }
  // Caller must claim themselves as the artist (no spoofing).
  if (!body.artist || body.artist.toLowerCase() !== sessionAddress) {
    return NextResponse.json({ error: 'artist must match session address' }, { status: 403 })
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
    return NextResponse.json(
      { error: 'Could not verify collection admin on-chain' },
      { status: 502 },
    )
  }

  const source: CollectionSource = body.source === 'auto-deploy' ? 'auto-deploy' : 'create-form'
  await addTrackedCollection(
    body.address,
    {
      name: body.name ?? body.address,
      image: body.image,
      description: body.description,
      artist: sessionAddress,
    },
    source,
  )
  if (source === 'create-form' && body.coverTokenId && /^\d+$/.test(body.coverTokenId)) {
    await markCoverMoment(body.address, body.coverTokenId)
  }
  return NextResponse.json({ ok: true })
}
