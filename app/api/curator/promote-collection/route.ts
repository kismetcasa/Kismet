import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { verifyPrivilegedSession } from '@/lib/curator'
import { markCreatedCollection, unmarkCreatedCollection } from '@/lib/kv'

// Curator-gated. Promotes a contract address into the curator-blessed
// `kismetart:created-collections` set so it surfaces in the Collections
// feed, profile collections, mint dropdown picker, and search.
//
// Used to bring legacy real collections (deployed before write-time
// tracking shipped) back into the UI, and to undo false negatives. Pass
// `unmark: true` to remove instead.
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
  return NextResponse.json({ promoted: true })
}
