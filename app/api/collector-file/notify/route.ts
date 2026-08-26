import { NextRequest, NextResponse, after } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { redis } from '@/lib/redis'
import { cfileRef } from '@/lib/collectorFileCore'
import {
  cfileNotifyLockKey,
  getCfileAudienceCount,
  getCfileRecord,
} from '@/lib/collectorFile'
import { parseCfileParams, requireCfileManager } from '@/lib/collectorFileGate'
import { CFILE_FANOUT_CEILING, notifyCollectorsOfUpdate } from '@/lib/collectorFileFanout'

export const runtime = 'nodejs'

/**
 * Explicit "tell collectors the file changed" (COLLECTOR_DOWNLOADS_DESIGN.md
 * §6.2) — also reachable as PUT ?notify=1. Pre-checks the cooldown and the
 * refusal ceiling synchronously so the artist gets an honest 409/413 for the
 * common cases; the fanout itself re-takes the cooldown atomically (SET NX)
 * so a racing double-click degrades to one blast, never two.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`cfile-notify:${ip}`, 10, 60))) {
    return errorResponse(429, 'Too many requests')
  }
  const params = parseCfileParams(req)
  if (!params) return errorResponse(400, 'Invalid collection or tokenId')
  const auth = await requireCfileManager(req, params)
  if (auth instanceof NextResponse) return auth

  const body = (await req.json().catch(() => null)) as { note?: string } | null
  const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 140) || undefined : undefined

  const record = await getCfileRecord(params.collection, params.tokenId)
  if (!record?.current) return errorResponse(404, 'No file attached to this artwork')

  const cooldownTtl = await redis
    .ttl(cfileNotifyLockKey(cfileRef(params.collection, params.tokenId)))
    .catch(() => -2)
  if (cooldownTtl > 0) {
    return NextResponse.json(
      { error: 'Collectors were already notified recently', retryInSecs: cooldownTtl },
      { status: 409 },
    )
  }

  const audience = await getCfileAudienceCount(params.collection, params.tokenId)
  if (audience > CFILE_FANOUT_CEILING) {
    // Refusal, not truncation (design §6.2): the passive update badge is the
    // path for editions this size until ops raises the ceiling with the
    // Upstash budget cap.
    return NextResponse.json(
      {
        error: `This edition is too large for direct notification (${audience} collectors) — collectors will see the update badge`,
        audience,
        ceiling: CFILE_FANOUT_CEILING,
      },
      { status: 413 },
    )
  }

  after(() =>
    notifyCollectorsOfUpdate({
      collection: params.collection,
      tokenId: params.tokenId,
      actor: auth.address,
      note: note ?? record.current?.note,
    }).catch(() => {}),
  )
  return NextResponse.json({ queued: true, audience })
}
