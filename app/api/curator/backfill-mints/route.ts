import { NextRequest, NextResponse } from 'next/server'
import { redis } from '@/lib/redis'
import { INPROCESS_API } from '@/lib/inprocess'
import { verifyPrivilegedSession } from '@/lib/curator'

// Curator-gated one-shot. Walks every contract in kismetart:collections
// (including auto-deploy wrappers and legacy create-form deploys),
// fetches each contract's moments from inprocess, and SADDs each
// `<addr>:<tokenId>` to kismetart:created-mints. After this runs, the
// Mints feed populates with every historical Kismet-tracked moment,
// not just the going-forward ones tracked at mint-proxy time.
//
// Idempotent — SADD is a no-op for existing members. Re-run any time.
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

  let mintsAdded = 0
  let contractsScanned = 0
  for (const addr of tracked) {
    try {
      const url = new URL(`${INPROCESS_API}/timeline`)
      url.searchParams.set('collection', addr)
      url.searchParams.set('limit', '100')
      url.searchParams.set('chain_id', '8453')
      const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
      if (!res.ok) continue
      const data = await res.json()
      const moments = Array.isArray(data.moments) ? data.moments : []
      await Promise.all(
        moments.map(async (m: { address?: string; token_id?: string }) => {
          if (!m.address || !m.token_id) return
          // SADD returns 1 for new members, 0 for existing. Count just
          // the deltas so the toast reflects actual new state.
          const added = await redis.sadd(
            'kismetart:created-mints',
            `${m.address.toLowerCase()}:${m.token_id}`,
          )
          if (Number(added) > 0) mintsAdded++
        }),
      )
      contractsScanned++
    } catch {
      // partial scan is fine — re-run completes any contracts that errored
    }
  }

  return NextResponse.json({ mintsAdded, contractsScanned })
}
