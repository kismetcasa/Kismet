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

  // Single-collection metadata lookup used by MomentDetailView to show the
  // collection name + cover image in the moment detail panel. Only returns
  // data for user-created platform collections (tracked in KV, not the
  // platform default) so standalone moments don't show a collection header.
  if (singleAddress) {
    if (!isAddress(singleAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
    }
    const lowerAddr = singleAddress.toLowerCase()
    const platformLower = PLATFORM_COLLECTION.toLowerCase()
    if (lowerAddr === platformLower) {
      return NextResponse.json({ contractAddress: singleAddress })
    }
    // Gate the rich response on the curated-collection set (every tracked
    // entry minus auto-deploy markers minus PLATFORM). Auto-deployed
    // wrappers are real on-chain contracts but they're functionally
    // individual mints — the moment-detail collection chip shouldn't
    // render a name/cover for them, so we fall through to the minimal
    // {contractAddress} stub the same way we do for the platform contract
    // and unknown contracts. Legacy entries with no marker default to
    // "real collection" and keep rendering their chip.
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

  // Discovery feed: enumerate the curated-collection set (every tracked
  // address minus PLATFORM minus auto-deploy markers) and hydrate each
  // with the rich shape from inprocess `/api/collection`, falling back to
  // KV-stored metadata when the indexer hasn't picked the collection up
  // yet. Auto-deployed mint wrappers and the platform contract are
  // excluded inside getUserCollections, so legacy entries (no marker)
  // flow through as real collections by default — preserving the
  // mint-into-existing path for users who deployed before the marker
  // existed. Returning the global inprocess feed here would surface
  // collections we didn't deploy and hide our own freshly-deployed ones
  // until the indexer catches up — neither matches the discovery
  // semantics we want.
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
              // Trust only plain objects with at least one field — inprocess
              // returns null when a collection isn't indexed yet, and we
              // want to fall through to the KV fallback in that case.
              if (
                data &&
                typeof data === 'object' &&
                !Array.isArray(data) &&
                Object.keys(data).length > 0
              ) {
                // Override `contractAddress` with the address from our
                // tracked set so the card's link uses the same casing the
                // rest of the app stores (and so we never accidentally
                // route on a missing/typo'd field).
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
      // Filter the artist's collections to the curated-collection set —
      // auto-deployed mint wrappers belong with the artist's mints, not
      // their collections. getCollectionsByArtist already walks the same
      // set for the KV fallback below, so the two paths agree on what
      // counts as a collection.
      const userSet = new Set(userCreated.map((a: string) => a.toLowerCase()))
      // Hide creator-hidden collections from non-creator viewers — the artist
      // sees their own hidden collections so they can navigate back and unhide.
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
      // Merge KV-tracked collections that the indexer hasn't picked up yet.
      // Shape matches what ProfileView consumes: contractAddress + metadata fields.
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
      // Even if inprocess is down, return what we have locally so fresh
      // collections aren't completely invisible.
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
    // 'create-form' = explicit Create Collection form (default for legacy
    // callers that don't pass the field). 'auto-deploy' = MintForm's
    // first-mint wrapper, which writes the AUTO_DEPLOY_KEY marker that
    // gates every collection-shaped surface from rendering it.
    source?: CollectionSource
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 })
  }
  // Caller must claim themselves as the artist — prevents one user from
  // populating another's profile page.
  if (!body.artist || body.artist.toLowerCase() !== sessionAddress) {
    return NextResponse.json({ error: 'artist must match session address' }, { status: 403 })
  }

  // Caller must have ADMIN bit on the collection on-chain. This is the same
  // check Zora uses when gating addPermission/setSale; we read it directly
  // rather than trusting an off-chain claim. tokenId 0 is the collection-wide
  // permission row.
  // The public Base RPC default lags behind the chain head enough that a
  // freshly-mined deploy can read 0 permissions (false negative → 403).
  // Retry a few times on either a false-negative or RPC error to ride out
  // propagation lag. serverBaseClient routes through
  // NEXT_PUBLIC_BASE_RPC_URL when set (paid Alchemy/Infura) so the lag
  // is shorter to begin with — the retry is belt-and-suspenders for the
  // tail latency of even a paid provider's slowest replica.
  // Outer retry-on-zero loop: distinct from readPermissions's internal
  // retry-on-throw. The two cover different failure modes:
  //   - readPermissions retries on RPC throw (transient network)
  //   - this loop ALSO retries on a definitive `perms=0` read, because
  //     the deploy tx may have just landed and the chain head can be
  //     1-2 blocks ahead of the RPC's slowest replica. Retrying on zero
  //     gives time for the new state to propagate.
  // We pass `retries: 1` so each outer iteration does one read, and the
  // outer loop owns the wider retry/backoff schedule.
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

  // Default source is 'create-form' so legacy callers and the explicit
  // Create Collection form (which doesn't pass the field) write only to
  // KEY — no AUTO_DEPLOY_KEY marker. MintForm's auto-deploy path passes
  // 'auto-deploy' explicitly, which writes the marker and keeps the
  // wrapper out of every collection-shaped surface.
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
  return NextResponse.json({ ok: true })
}
