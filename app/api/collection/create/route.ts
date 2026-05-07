import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { addTrackedCollection } from '@/lib/kv'
import { getSessionAddress } from '@/lib/session'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

interface SplitInput {
  address: string
  percentAllocation: number
}

/**
 * Proxy to inprocess `POST /api/collections` (collection deploy).
 *
 * Why we route through inprocess instead of calling Zora's factory directly
 * from the user's wallet: when inprocess deploys, their platform smart
 * account ends up with ADMIN on the new collection — and that's the *only*
 * way subsequent `/api/mint` calls can succeed. A collection deployed via
 * Zora's factory directly (with the user as defaultAdmin and no ADMIN
 * grant for inprocess's smart account) reverts every mint at gas
 * estimation: "useroperation reverted: execution reverted" because
 * setupNewToken is gated on the ADMIN bit.
 *
 * UX wins as a side effect: inprocess pays the deploy gas via their
 * sponsored API key, and the user's wallet is still set as defaultAdmin
 * per the docs.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`collection-create:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const apiKey = process.env.INPROCESS_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'INPROCESS_API_KEY not configured' }, { status: 500 })
  }

  // Authenticated caller — Kismet session cookie required so we can bind
  // the deploy to a known address (used as the inprocess `account` field
  // and the KV `artist` for profile listings).
  const sessionAddress = await getSessionAddress(req)
  if (!sessionAddress) {
    return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })
  }

  let body: {
    name?: string
    uri?: string
    image?: string
    description?: string
    splits?: SplitInput[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 })
  }
  // Inprocess uses this URI as the contractURI on-chain; ar:// or https://
  // are the formats their indexer + the contract resolve cleanly.
  if (!body.uri?.trim() || (!body.uri.startsWith('ar://') && !body.uri.startsWith('https://'))) {
    return NextResponse.json({ error: 'uri must be ar:// or https://' }, { status: 400 })
  }

  // Splits validation (optional). Inprocess docs require ≥2 recipients
  // summing to 100 with valid addresses; failing fast here saves a round-trip.
  if (body.splits !== undefined) {
    if (!Array.isArray(body.splits)) {
      return NextResponse.json({ error: 'splits must be an array' }, { status: 400 })
    }
    if (body.splits.length === 1) {
      return NextResponse.json({ error: 'splits require at least 2 recipients' }, { status: 400 })
    }
    if (body.splits.length > 1) {
      let sum = 0
      for (const s of body.splits) {
        if (!s || typeof s !== 'object' || !isAddress(s.address)) {
          return NextResponse.json({ error: 'invalid splits address' }, { status: 400 })
        }
        if (
          typeof s.percentAllocation !== 'number' ||
          !Number.isInteger(s.percentAllocation) ||
          s.percentAllocation < 1 ||
          s.percentAllocation > 100
        ) {
          return NextResponse.json(
            { error: 'splits allocation must be a whole number 1–100' },
            { status: 400 },
          )
        }
        sum += s.percentAllocation
      }
      if (sum !== 100) {
        return NextResponse.json(
          { error: `splits must sum to 100% (got ${sum}%)` },
          { status: 400 },
        )
      }
    }
  }

  let upstream: Response
  try {
    upstream = await fetch(`${INPROCESS_API}/collections`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        Accept: 'application/json',
      },
      body: JSON.stringify({
        account: sessionAddress,
        name: body.name.trim(),
        uri: body.uri.trim(),
        ...(Array.isArray(body.splits) && body.splits.length >= 2 ? { splits: body.splits } : {}),
      }),
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: 'upstream unreachable',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    )
  }

  const text = await upstream.text()
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    console.error(
      `[collection/create] upstream non-JSON: status=${upstream.status} body=${text.slice(0, 500)}`,
    )
    return NextResponse.json(
      { error: 'upstream error', status: upstream.status, detail: text.slice(0, 200) },
      { status: 502 },
    )
  }

  if (!upstream.ok) {
    console.error(
      `[collection/create] upstream ${upstream.status}: ${JSON.stringify(data).slice(0, 500)}`,
    )
    return NextResponse.json(data, { status: upstream.status })
  }

  // On success: persist a KV row so the collection appears in our discovery
  // feed and on the artist's profile immediately, without waiting for the
  // inprocess indexer to catch up.
  const r = data as { contractAddress?: string }
  if (r.contractAddress && isAddress(r.contractAddress)) {
    await addTrackedCollection(r.contractAddress, {
      name: body.name.trim(),
      image: body.image,
      description: body.description,
      artist: sessionAddress,
    }).catch(() => {})
  }

  return NextResponse.json(data, { status: upstream.status })
}
