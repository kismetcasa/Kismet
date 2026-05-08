import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { INPROCESS_API } from '@/lib/inprocess'
import { PLATFORM_COLLECTION } from '@/lib/config'
import { verifyPrivilegedSession } from '@/lib/curator'

// Curator-gated one-shot. Marks any tracked contract holding exactly
// one moment as an auto-deploy wrapper — pulls legacy first-mint
// contracts out of the Collections feed without touching empty
// Create Collection deploys (count = 0, indexer lag tolerated by
// re-running) or multi-mint Create Collection deploys (count > 1).
// Idempotent.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    signature?: string
    timestamp?: number
    signerAddress?: string
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

  const err = await verifyPrivilegedSession(body)
  if (err) return NextResponse.json({ error: err.error }, { status: err.status })

  const tracked = (await redis.smembers('kismetart:collections')) as string[]
  const platform = PLATFORM_COLLECTION.toLowerCase()
  const candidates = tracked.filter((a) => a.toLowerCase() !== platform)

  let marked = 0
  for (const addr of candidates) {
    try {
      const url = new URL(`${INPROCESS_API}/timeline`)
      url.searchParams.set('collection', addr)
      url.searchParams.set('limit', '2')
      url.searchParams.set('chain_id', '8453')
      const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const data = await res.json()
      const moments = Array.isArray(data.moments) ? data.moments : []
      if (moments.length === 1) {
        const added = await redis.sadd('kismetart:auto-deploy-collections', addr)
        if (Number(added) > 0) marked++
      }
    } catch {
      // skip on per-collection error — partial backfill is fine, re-run completes it
    }
  }

  return NextResponse.json({ marked, scanned: candidates.length })
}
