import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { isBlacklisted } from '@/lib/blacklist'
import { holdsValidPass, isPlatformPausedFor } from '@/lib/gate'
import { verifyTypedIntent } from '@/lib/intentAuth'
import type { IntentEnvelope } from '@/lib/intent'
import { buildOpenDropMessage, OPEN_DROP_TYPES, validateOpenDrop } from '@/lib/drops'
import { writeDrop } from '@/lib/arkiv/drops'
import { writerIsFunded } from '@/lib/arkiv/client'
import { getDropsFeed, invalidateDropReads, isDropsEnabled, wasUploaded } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * GET  /api/drops — open drops (soonest-closing first) and drops waiting to
 *      settle, read from Arkiv (cached briefly, lib/dropsStore). Reads are
 *      served from that shared cache, so the per-IP limit is generous: a
 *      venue's worth of viewers can share one address.
 * POST /api/drops — open a drop: verify the artist's OpenDrop intent, check
 *      the Pass gate, and write a read-only `kismet.drop.v1` entity that the
 *      artist owns.
 */
export async function GET(req: NextRequest) {
  if (!(await checkRateLimit(`drops-list:${getClientIp(req)}`, 600, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')
  try {
    return NextResponse.json(await getDropsFeed(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-list')
  }
}

export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`drops-open:${getClientIp(req)}`, 10, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  if (typeof body.account !== 'string' || !isAddress(body.account)) {
    return errorResponse(400, 'account is required and must be a valid address')
  }
  const account = body.account.toLowerCase()

  const validated = validateOpenDrop(body, Math.floor(Date.now() / 1000))
  if (!validated.ok) return errorResponse(400, validated.error)
  const fields = validated.value

  // The signature binds every term (title, description hash, artwork, close
  // time, cap) — anything changed between the wallet and here fails it.
  const envelope = body.intent as IntentEnvelope | undefined
  const verified = await verifyTypedIntent({
    envelope,
    account,
    types: OPEN_DROP_TYPES,
    primaryType: 'OpenDrop',
    buildMessage: (nonce, expiresAt) =>
      buildOpenDropMessage(account, fields, nonce, expiresAt) as unknown as Record<string, unknown>,
  })
  if (!verified.ok) return errorResponse(verified.status, verified.error)

  const [blocked, paused, hasPass, uploaded] = await Promise.all([
    isBlacklisted(account),
    isPlatformPausedFor(account),
    holdsValidPass(account),
    wasUploaded(fields.swarmRef),
  ])
  if (blocked) return errorResponse(403, 'Address is blocked')
  if (paused) return errorResponse(503, 'Platform is temporarily paused')
  if (!hasPass) return errorResponse(403, 'A Kismet Pass is required to open a drop')
  if (!uploaded) return errorResponse(400, 'Upload the artwork again — that upload has expired')
  // A drop that opens but can't record claims is worse than one that waits.
  if (!(await writerIsFunded())) return errorResponse(503, 'Drops are paused for a moment — try again shortly')

  if (!(await consumeUserQuota('drop-open', account, 1))) {
    return errorResponse(429, 'Daily drop limit reached — try again tomorrow')
  }

  try {
    const { entityKey, txHash } = await writeDrop({
      artist: getAddress(account),
      fields,
      intent: { signature: envelope!.signature as `0x${string}`, nonce: envelope!.nonce, expiresAt: envelope!.expiresAt },
    })
    invalidateDropReads(entityKey)
    return NextResponse.json({ key: entityKey.toLowerCase(), txHash })
  } catch (err) {
    return upstreamError(503, 'Could not record the drop on Arkiv — try again', err, 'drops-open')
  }
}
