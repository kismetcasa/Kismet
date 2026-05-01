import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { INPROCESS_API } from '@/lib/inprocess'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist')

  if (artist && !isAddress(artist)) {
    return NextResponse.json({ error: 'Invalid artist address' }, { status: 400 })
  }

  const url = new URL(`${INPROCESS_API}/payments`)
  if (artist) url.searchParams.set('artist', artist)

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    const text = await res.text()
    return NextResponse.json(JSON.parse(text), { status: res.status })
  } catch {
    return NextResponse.json({ error: 'upstream error' }, { status: 502 })
  }
}
