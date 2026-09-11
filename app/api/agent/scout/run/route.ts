import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { getSessionAddress } from '@/lib/session'
import { redis } from '@/lib/redis'
import { getScoutSpender, type ScoutSpender } from '@/lib/agent/scout/spender'
import { runScoutServer } from '@/lib/agent/scout/runScoutServer'
import { SITE_URL } from '@/lib/siteUrl'

export const runtime = 'nodejs'

/**
 * Trigger an autonomous scout run for the session user. Trigger: the client
 * calls this on app-open + "Run now". A per-owner lock (SET NX, released in
 * finally) stops concurrent runs (two tabs / repeated opens) from overlapping —
 * the TTL is only the crash-safety net, so it must OUTLIVE the slowest honest
 * run or an overlapping second run starts while the first is still submitting.
 * Worst case per collect ≈ 45s spender-mutex wait + 60s user-op wait; at the
 * default 5 items/period that is ~9 min, so 900s. (Double-collecting a drop is
 * blocked regardless by the per-(user,drop) lock + on-chain balance dedup, and
 * spend by the on-chain Spend Permission; this lock keeps the item counter
 * honest and avoids needless contention.)
 */
const RUN_LOCK_TTL_S = 900
export async function POST(req: NextRequest) {
  const owner = await getSessionAddress(req)
  if (!owner) return errorResponse(401, 'Sign in to continue')

  const lockKey = `kismetart:scout-run:${owner.toLowerCase()}`
  let acquired = true
  try {
    acquired = (await redis.set(lockKey, '1', { nx: true, ex: RUN_LOCK_TTL_S })) === 'OK'
  } catch {
    /* lock unavailable — proceed; the on-chain cap is the real guard */
  }
  if (!acquired) return NextResponse.json({ ran: false, reason: 'a run is already in progress' })

  // The spender needs a server key (SCOUT_SPENDER_PRIVATE_KEY) or CDP creds.
  // Async: the CDP path resolves its smart account over the network.
  let spender: ScoutSpender
  try {
    spender = await getScoutSpender()
  } catch (e) {
    try { await redis.del(lockKey) } catch {}
    return errorResponse(503, e instanceof Error ? e.message : 'Agent spender not configured')
  }

  try {
    const summary = await runScoutServer({ owner, baseUrl: SITE_URL, spender })
    return NextResponse.json({ ran: true, ...summary })
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : 'Run failed')
  } finally {
    try { await redis.del(lockKey) } catch {}
  }
}
