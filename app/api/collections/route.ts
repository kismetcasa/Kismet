import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, http, type Address } from 'viem'
import { isAddress } from '@/lib/address'
import { base } from 'viem/chains'
import { INPROCESS_API } from '@/lib/inprocess'
import { PLATFORM_COLLECTION } from '@/lib/config'
import {
  getTrackedCollections,
  addTrackedCollection,
  getCollectionsByArtist,
  getCollectionMeta,
} from '@/lib/kv'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { getHiddenCollectionsSet } from '@/lib/hiddenCollections'

// Zora 1155 PERMISSION_BIT_ADMIN = 2 (= 2^1). Anyone with this bit can mutate
// the contract. We require the caller to have it before letting them register
// the collection in our tracked list — otherwise anyone could pollute artist
// pages with arbitrary contract addresses.
const PERMISSION_BIT_ADMIN = 2n

const COLLECTION_PERMISSIONS_ABI = [
  {
    name: 'permissions',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist')
  const feed = searchParams.get('feed')
  const singleAddress = searchParams.get('address')

  // Single-collection metadata lookup used by MomentDetailView to show the
  // collection name + cover image in the moment detail panel.
  if (singleAddress) {
    if (!isAddress(singleAddress)) {
      return NextResponse.json({ error: 'Invalid address' }, { status: 400 })
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

  // Discovery feed: enumerate the collections tracked in our KV (deployed
  // through this client + the platform collection). Hydrate each with the
  // rich shape from inprocess `/api/collection`, falling back to KV-stored
  // metadata when the indexer hasn't picked the collection up yet.
  // Returning the global inprocess feed here would surface collections we
  // didn't deploy and hide our own freshly-deployed ones until the indexer
  // catches up — neither matches the discovery semantics we want.
  if (feed) {
    const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') ?? '18', 10) || 18))
    const [tracked, hiddenSet] = await Promise.all([
      getTrackedCollections(),
      getHiddenCollectionsSet(),
    ])
    const platformLower = PLATFORM_COLLECTION.toLowerCase()
    const visible = tracked.filter(
      (addr) => !hiddenSet.has(addr.toLowerCase()) && addr.toLowerCase() !== platformLower,
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
      const [res, tracked, kvOwned, hiddenSet, viewer] = await Promise.all([
        fetch(url.toString(), {
          headers: { Accept: 'application/json' },
          next: { revalidate: 120 },
        }),
        getTrackedCollections(),
        getCollectionsByArtist(artist),
        getHiddenCollectionsSet(),
        getSessionAddress(req),
      ])
      const text = await res.text()
      const data = JSON.parse(text)
      const trackedSet = new Set(tracked.map((a: string) => a.toLowerCase()))
      // Hide creator-hidden collections from non-creator viewers — the artist
      // sees their own hidden collections so they can navigate back and unhide.
      const isOwnProfile = viewer?.toLowerCase() === artist.toLowerCase()
      const inprocessAddrs = new Set<string>()
      if (Array.isArray(data.collections)) {
        data.collections = data.collections.filter(
          (c: { contractAddress?: string }) => {
            if (!c.contractAddress) return false
            const lower = c.contractAddress.toLowerCase()
            if (!trackedSet.has(lower)) return false
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
  try {
    const client = createPublicClient({ chain: base, transport: http() })
    const perms = (await client.readContract({
      address: body.address as Address,
      abi: COLLECTION_PERMISSIONS_ABI,
      functionName: 'permissions',
      args: [0n, sessionAddress as Address],
    })) as bigint
    const isAdmin = (perms & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
    if (!isAdmin) {
      return NextResponse.json({ error: 'Caller is not admin of this collection' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'Could not verify collection admin on-chain' }, { status: 502 })
  }

  await addTrackedCollection(body.address, {
    name: body.name ?? body.address,
    image: body.image,
    description: body.description,
    artist: sessionAddress,
  })
  return NextResponse.json({ ok: true })
}
