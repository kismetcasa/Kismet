import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { consumeUserQuota } from '@/lib/userQuota'
import { isBlacklisted } from '@/lib/blacklist'
import { isPlatformPausedFor } from '@/lib/gate'
import { verifyTypedIntent } from '@/lib/intentAuth'
import type { IntentEnvelope } from '@/lib/intent'
import { buildClaimDropMessage, CLAIM_DROP_TYPES, isEntityKey, normalizeEntityKey, recordExpiresAt } from '@/lib/drops'
import { isArkivWritable } from '@/lib/arkiv/client'
import { writeClaim } from '@/lib/arkiv/drops'
import { getDropTerms, isDropsEnabled, releaseClaim, reserveClaim } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * POST /api/drops/{key}/claim — claim a drop. The collector signs a ClaimDrop
 * intent (no gas, no fee, no ETH needed); Kismet writes a read-only
 * `kismet.claim.v1` entity on Arkiv and hands it to the collector.
 *
 * Order matters: the signature is checked first (it proves who is asking),
 * then the drop is read from Arkiv and must still be open, then Redis
 * atomically reserves one slot per wallet under the cap (Arkiv has no
 * conditional write), then the quota, then the Arkiv write. Any failure after
 * the reservation gives the slot back, so the wallet can simply retry.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`drops-claim:${ip}`, 20, 60))) return errorResponse(429, 'Too many requests')
  if (!(await isDropsEnabled())) return errorResponse(404, 'Not found')
  if (!isArkivWritable()) return errorResponse(503, 'Drops are read-only right now')

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

  let terms
  try {
    terms = await getDropTerms(dropKey)
  } catch (err) {
    return upstreamError(503, 'Arkiv is unavailable — try again shortly', err, 'drops-claim')
  }
  if (!terms) return errorResponse(404, 'Drop not found — it may have expired')

  const nowSec = Math.floor(Date.now() / 1000)
  if (nowSec >= terms.closesAt) return errorResponse(409, 'This drop has closed')
  if (terms.artist === account) return errorResponse(400, 'You opened this drop — your copy comes with the mint')

  const collector = getAddress(account)
  let reserved
  try {
    reserved = await reserveClaim(dropKey, collector, terms.maxClaims, recordExpiresAt(terms.closesAt))
  } catch (err) {
    return upstreamError(503, 'Temporarily unavailable — please retry', err, 'drops-claim')
  }
  if (reserved === 'duplicate') return NextResponse.json({ already: true })
  if (reserved === 'full') return errorResponse(409, 'All claims are taken')

  if (!(await consumeUserQuota('drop-claim', account, 1))) {
    await releaseClaim(dropKey, collector).catch(() => {})
    return errorResponse(429, 'Daily claim limit reached — try again tomorrow')
  }

  try {
    const { entityKey, txHash } = await writeClaim({
      dropKey,
      dropClosesAt: terms.closesAt,
      collector,
      claimedAt: nowSec,
      intent: {
        signature: envelope!.signature as `0x${string}`,
        nonce: envelope!.nonce,
        expiresAt: envelope!.expiresAt,
      },
    })
    return NextResponse.json({ claimKey: entityKey.toLowerCase(), txHash })
  } catch (err) {
    await releaseClaim(dropKey, collector).catch(() => {})
    return upstreamError(503, 'Could not record the claim on Arkiv — try again', err, 'drops-claim')
  }
}
