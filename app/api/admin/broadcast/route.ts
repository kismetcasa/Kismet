import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'
import {
  BROADCAST_LIMITS,
  broadcastFarcasterPush,
  estimateBroadcastReach,
  getBroadcastRecord,
  sendBroadcastTestTo,
  validateBroadcastInput,
} from '@/lib/farcasterNotifications'

// Admin-only Farcaster push broadcast: one announcement to every user who
// added Kismet with notifications enabled (holds a live host token) AND has
// the Kismet master push toggle on. See the Broadcast section of
// lib/farcasterNotifications.ts for the full recipient/idempotency model.
//
// POST { dryRun: true }                          → reach estimate, no sends
// POST { testFid, notificationId, … }            → smoke test: send to ONE fid
// POST { notificationId, title, body, targetUrl? } → send; returns run stats
// GET  ?notificationId=…                          → stored stats for a past run
//
// Re-POSTing the same notificationId is the supported retry path: hosts
// dedupe (FID, notificationId) for 24h, so a re-run only reaches tokens that
// were rate-limited or unreachable the first time.

export const dynamic = 'force-dynamic'
// A full run is bounded by (#tokens / 100) POSTs at 4-wide with a 10s
// per-POST timeout — comfortably inside 300s for any realistic index size.
// maxDuration is a Vercel-only hint; on the persistent deployment target
// (Coolify) the handler runs to completion regardless.
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-broadcast-get:${ip}`, 30, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const notificationId = new URL(req.url).searchParams.get('notificationId')?.trim()
  if (!notificationId) return errorResponse(400, 'notificationId query param is required')

  const record = await getBroadcastRecord(notificationId)
  if (!record) return errorResponse(404, 'No broadcast record for that notificationId (30d retention)')
  return NextResponse.json({ record })
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  // Tighter than other admin POSTs — each real invocation fans out to every
  // user, so even the admin shouldn't be able to machine-gun it.
  const allowed = await checkRateLimit(`admin-broadcast:${ip}`, 5, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    dryRun?: boolean
    testFid?: number
    notificationId?: string
    title?: string
    body?: string
    targetUrl?: string
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  if (body.dryRun === true) {
    // Reach estimate only — enumerates (and self-heals) the index, sends
    // nothing, so it needs no audit entry and no input fields.
    const reach = await estimateBroadcastReach()
    return NextResponse.json({ dryRun: true, reach })
  }

  const input = {
    notificationId: body.notificationId ?? '',
    title: body.title ?? '',
    body: body.body ?? '',
    targetUrl: body.targetUrl,
  }

  if (body.testFid !== undefined) {
    // Smoke test: deliver the exact payload to one FID through the same
    // validation + send path, so "it buzzed on my phone" is evidence for
    // the full run. Gated identically (master toggle included) so a test
    // can never notify a user who opted out.
    if (!Number.isInteger(body.testFid) || body.testFid <= 0) {
      return errorResponse(400, 'testFid must be a positive integer FID')
    }
    const test = await sendBroadcastTestTo(body.testFid, input)
    if (!test.ok) {
      if (test.error === 'invalid-input') return errorResponse(400, test.detail)
      if (test.error === 'master-off') {
        return errorResponse(409, `FID ${body.testFid} has the Kismet push master toggle off`)
      }
      return errorResponse(404, `No notification tokens stored for FID ${body.testFid}`)
    }
    await recordAdminAction('fc-broadcast.test', {
      actor: auth.signer,
      meta: { testFid: body.testFid, notificationId: input.notificationId.trim() },
    })
    return NextResponse.json({ ok: true, test })
  }
  // Pre-validate for a precise 400 before doing any Redis work; the lib
  // re-validates internally (single source of truth for the spec caps).
  const validated = validateBroadcastInput(input)
  if (!validated.ok) return errorResponse(400, validated.error)

  const outcome = await broadcastFarcasterPush(input)
  if (!outcome.ok) {
    if (outcome.error === 'locked') {
      return errorResponse(409, 'A broadcast is already running — retry when it finishes')
    }
    return errorResponse(400, outcome.detail)
  }

  await recordAdminAction('fc-broadcast.send', {
    actor: auth.signer,
    meta: {
      notificationId: outcome.notificationId,
      title: validated.title,
      eligibleFids: outcome.eligibleFids,
      successfulTokens: outcome.successfulTokens,
      invalidTokens: outcome.invalidTokens,
      rateLimitedTokens: outcome.rateLimitedTokens,
      failedRequests: outcome.failedRequests,
    },
  })

  return NextResponse.json({ ok: true, result: outcome, limits: BROADCAST_LIMITS })
}
