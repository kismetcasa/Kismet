import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { verifyPrivilegedSession } from '@/lib/curator'
import { markCreatedCollection, markCreatedMint, unmarkCreatedCollection } from '@/lib/kv'
import { INPROCESS_API } from '@/lib/inprocess'

// Curator-gated. Promotes a legacy collection into the curator-blessed
// `kismetart:created-collections` set so it surfaces in the Collections
// feed, profile collections, mint dropdown picker, and search. Also
// backfills every moment inside that collection into
// `kismetart:created-mints` so the moments appear in the Mints feed
// without a separate per-mint promote step.
//
// Pass `unmark: true` to remove the collection mark (does NOT unbackfill
// the moments — those stay in created-mints by design; the curator can
// SREM individual entries if needed).
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    address?: string
    unmark?: boolean
    signature?: string
    timestamp?: number
    signerAddress?: string
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const err = await verifyPrivilegedSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: 'valid address required' }, { status: 400 })
  }

  if (body.unmark) {
    const removed = await unmarkCreatedCollection(body.address)
    return NextResponse.json({ removed })
  }

  await markCreatedCollection(body.address)

  // Pull the collection's moments from inprocess and add each to
  // created-mints so the Mints feed populates without the curator
  // needing to re-mint anything. Cap at 100 (inprocess's per-call
  // limit); collections beyond that need a re-run or a richer backfill.
  let mintsBackfilled = 0
  try {
    const url = new URL(`${INPROCESS_API}/timeline`)
    url.searchParams.set('collection', body.address)
    url.searchParams.set('limit', '100')
    url.searchParams.set('chain_id', '8453')
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
    if (res.ok) {
      const data = await res.json()
      const moments = Array.isArray(data.moments) ? data.moments : []
      await Promise.all(
        moments.map(async (m: { address?: string; token_id?: string }) => {
          if (m.address && m.token_id) {
            await markCreatedMint(m.address, m.token_id)
            mintsBackfilled++
          }
        }),
      )
    }
  } catch {
    // promote still succeeds even if the moment backfill fails — the
    // curator can re-run promote later, or hit the global mint backfill.
  }

  return NextResponse.json({ promoted: true, mintsBackfilled })
}
