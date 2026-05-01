import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'
import { getTrackedCollections, addTrackedCollection } from '@/lib/kv'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist')

  if (artist) {
    if (!isAddress(artist)) {
      return NextResponse.json({ error: 'Invalid artist address' }, { status: 400 })
    }
    const url = new URL(`${INPROCESS_API}/collections`)
    url.searchParams.set('artist', artist)
    url.searchParams.set('limit', '100')
    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 120 },
      })
      const text = await res.text()
      return NextResponse.json(JSON.parse(text), { status: res.status })
    } catch {
      return NextResponse.json({ error: 'upstream error' }, { status: 502 })
    }
  }

  const collections = await getTrackedCollections()
  return NextResponse.json({ collections })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`collections:${ip}`, 5, 60)
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = await req.json() as {
    address: string
    name?: string
    image?: string
    description?: string
  }
  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 })
  }
  await addTrackedCollection(body.address, {
    name: body.name ?? body.address,
    image: body.image,
    description: body.description,
  })
  return NextResponse.json({ ok: true })
}
