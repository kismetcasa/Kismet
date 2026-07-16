import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { inprocessUrl } from '@/lib/inprocess'
import { getTrackedCollections } from '@/lib/kv'
import { getHiddenUsersSet } from '@/lib/hidden-users'
import { getSessionAddress } from '@/lib/session'
import { errorResponse } from '@/lib/apiResponse'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const artist = searchParams.get('artist')

  // `artist` is REQUIRED. The hidden-users suppression gate below only makes
  // sense per-artist, and the old no-artist branch fetched the network-wide
  // /payments feed — which, once Kismet-scoped, would return a hidden artist's
  // own-collection sales in an unauthenticated platform-wide list, defeating
  // the suppression by simply dropping the query param. The only caller
  // (ProfileView) always passes an artist, so requiring it loses nothing.
  if (!artist || !isAddress(artist)) {
    return errorResponse(400, 'Invalid artist address')
  }

  // Hidden-users gate: short-circuit before hitting inprocess. We can't filter
  // individual items inside an inprocess passthrough response cheaply, so we
  // apply the gate at the query level — admin-hidden artist + non-owner viewer
  // = empty. Same own-profile exception as the per-content hide system.
  const [hiddenUsers, viewer] = await Promise.all([
    getHiddenUsersSet(),
    getSessionAddress(req),
  ])
  const artistLower = artist.toLowerCase()
  if (hiddenUsers.has(artistLower) && viewer?.toLowerCase() !== artistLower) {
    return NextResponse.json({ payments: [] }, { status: 200 })
  }

  const url = inprocessUrl('/payments', { artist })

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(8_000),
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
    // Kismet-scope the panel: the inprocess /payments feed is network-wide
    // (every In•Process app's sales), but the profile card above it reads
    // Kismet-scoped earnings (lib/stats.ts) — so an unfiltered list would show
    // sales the card doesn't count, and the two would visibly disagree. Keep
    // only rows whose token contract is a Kismet-tracked collection. A
    // non-array/absent `payments` (error envelope) passes through untouched so
    // this never turns a valid upstream error into a silent empty list.
    if (data && typeof data === 'object' && Array.isArray((data as { payments?: unknown }).payments)) {
      const tracked = new Set((await getTrackedCollections()).map((c) => c.toLowerCase()))
      const rows = (data as { payments: Array<{ token?: { contractAddress?: string } }> }).payments
      const scoped = rows.filter((p) => {
        // typeof check, not just optional chaining: a non-string
        // contractAddress (feed schema drift) would throw on .toLowerCase(),
        // escape the filter, and 502 the whole panel — the exact fragility the
        // JSON-parse guard above avoids. One bad row must not fail the request.
        const c = p?.token?.contractAddress
        return typeof c === 'string' ? tracked.has(c.toLowerCase()) : false
      })
      return NextResponse.json({ ...data, payments: scoped }, { status: res.status })
    }
    return NextResponse.json(data, { status: res.status })
  } catch {
    return errorResponse(502, 'upstream error')
  }
}
