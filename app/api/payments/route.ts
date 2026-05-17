import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { INPROCESS_API } from '@/lib/inprocess'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist')

  if (artist && !isAddress(artist)) {
    return errorResponse(400, 'Invalid artist address')
  }

  const url = new URL(`${INPROCESS_API}/payments`)
  if (artist) url.searchParams.set('artist', artist)

  try {
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
    })
    const text = await res.text()
    // inprocess returns non-JSON (often empty / "Not Found") when an artist
    // has no payments — degrade gracefully to an empty list instead of 502'ing
    // the whole panel on the profile page.
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return NextResponse.json({ payments: [] }, { status: 200 })
    }
    return NextResponse.json(data, { status: res.status })
  } catch {
    return errorResponse(502, 'upstream error')
  }
}
