import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { getSessionAddress } from '@/lib/session'
import { redis } from '@/lib/redis'
import { getScoutSpender, type ScoutSpender } from '@/lib/agent/scout/spender'
import { runScoutServer } from '@/lib/agent/scout/runScoutServer'

export const runtime = 'nodejs'

/**
 * Trigger an autonomous scout run for the session user. Trigger: the client
 * calls this on app-open + "Run now". A per-owner lock (SET NX, 120s, released
 * in finally) stops concurrent runs (two tabs / repeated opens) from
 * double-collecting — the TTL is just the crash-safety net. Spend stays bounded
 * by the on-chain Spend Permission, so the lock is belt-and-suspenders.
 */
export async function POST(req: NextRequest) {
  const owner = await getSessionAddress(req)
  if (!owner) return errorResponse(401, 'Sign in to continue')

  const lockKey = `kismetart:scout-run:${owner.toLowerCase()}`
  let acquired = true
  try {
    acquired = (await redis.set(lockKey, '1', { nx: true, ex: 120 })) === 'OK'
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
    const summary = await runScoutServer({ owner, baseUrl: new URL(req.url).origin, spender })
    return NextResponse.json({ ran: true, ...summary })
  } catch (e) {
    return errorResponse(500, e instanceof Error ? e.message : 'Run failed')
  } finally {
    try { await redis.del(lockKey) } catch {}
  }
}
