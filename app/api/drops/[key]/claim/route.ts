import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getFarcasterFid } from '@/lib/session'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { isBlacklisted } from '@/lib/blacklist'
import { isPlatformPausedFor } from '@/lib/gate'
import { verifyTypedIntent } from '@/lib/intentAuth'
import type { IntentEnvelope } from '@/lib/intent'
import { buildClaimDropMessage, CLAIM_DROP_TYPES, isDropOpen, isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { writeClaim } from '@/lib/arkiv/drops'
import { writerIsFunded } from '@/lib/arkiv/client'
import { getDropRecord, invalidateDropReads, isDropsEnabled, releaseClaim, reserveClaim } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * POST /api/drops/{key}/claim — claim a drop. The collector signs a ClaimDrop
 * intent (no gas, no fee, no ETH needed); Kismet writes a read-only
 * `kismet.claim.v1` entity on Arkiv and hands it to the collector.
 *
 * Order matters: the signature is checked first (it proves who is asking),
 * then the drop is read from Arkiv and must still be open, then Redis
 * atomically reserves one slot per wallet — and per Farcaster account when
 * the claim comes from the Mini App with a Quick Auth token — under the cap
 * (Arkiv has no conditional write), then the quota, then the Arkiv write. Any
 * failure after the reservation gives the slot back, so the wallet can simply
 * retry.
 *
 * 60 a minute per IP, the same as /api/auth/intent-nonce (every claim spends
 * one nonce): a room on one network can claim as fast as it can sign.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!(await checkRateLimit(`drops-claim:${getClientIp(req)}`, 60, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')
  const dropKey = normalizeEntityKey(raw)

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

  const envelope = body.intent as IntentEnvelope | undefined
  const verified = await verifyTypedIntent({
    envelope,
    account,
    types: CLAIM_DROP_TYPES,
    primaryType: 'ClaimDrop',
    buildMessage: (nonce, expiresAt) =>
      buildClaimDropMessage(account, dropKey, nonce, expiresAt) as unknown as Record<string, unknown>,
  })
  if (!verified.ok) return errorResponse(verified.status, verified.error)

  const [blocked, paused] = await Promise.all([isBlacklisted(account), isPlatformPausedFor(account)])
  if (blocked) return errorResponse(403, 'Address is blocked')
  if (paused) return errorResponse(503, 'Platform is temporarily paused')

  let drop
  try {
    drop = await getDropRecord(dropKey)
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-claim')
  }
  if (!drop) return errorResponse(404, 'Drop not found — it may have expired')

  const nowSec = Math.floor(Date.now() / 1000)
  if (!isDropOpen(drop.closesAt, nowSec)) return errorResponse(409, 'This drop has closed')
  if (drop.artist === account) return errorResponse(400, 'You opened this drop — your copy comes with the mint')
  if (!(await writerIsFunded())) return errorResponse(503, 'Claims are paused for a moment — try again shortly')

  const collector = getAddress(account)
  const fid = await getFarcasterFid(req)
  let reserved
  try {
    reserved = await reserveClaim(dropKey, collector, fid, drop.maxClaims, drop.closesAt)
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — please retry', err, 'drops-claim')
  }
  if (reserved === 'duplicate') return NextResponse.json({ already: true })
  if (reserved === 'account-claimed') return errorResponse(409, 'Your Farcaster account already claimed this drop')
  if (reserved === 'full') return errorResponse(409, 'All claims are taken')

  if (!(await consumeUserQuota('drop-claim', account, 1))) {
    await releaseClaim(dropKey, collector, fid).catch(() => {})
    return errorResponse(429, 'Daily claim limit reached — try again tomorrow')
  }

  try {
    const { entityKey, txHash } = await writeClaim({
      dropKey,
      dropClosesAt: drop.closesAt,
      collector,
      claimedAt: nowSec,
      intent: { signature: envelope!.signature as `0x${string}`, nonce: envelope!.nonce, expiresAt: envelope!.expiresAt },
    })
    invalidateDropReads(dropKey, collector)
    return NextResponse.json({ claimKey: entityKey.toLowerCase(), txHash })
  } catch (err) {
    await releaseClaim(dropKey, collector, fid).catch(() => {})
    return upstreamError(503, 'Could not record the claim on Arkiv — try again', err, 'drops-claim')
  }
}
