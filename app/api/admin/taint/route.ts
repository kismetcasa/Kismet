import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { getGateConfig } from '@/lib/gate'
import {
  clearLegacyTaint,
  clearOffPlatformUnits,
  listLegacyTaintedTokenIds,
  listOffPlatformUnits,
} from '@/lib/pass-validity'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyAdminSession } from '@/lib/curator'
import { errorResponse } from '@/lib/apiResponse'
import { recordAdminAction } from '@/lib/adminAudit'

/**
 * Admin inspection and remediation for Pass provenance — the record of which
 * units a holder acquired OFF-platform, which hasValidPass subtracts from the
 * balance they may prove.
 *
 * Route path kept as /api/admin/taint for continuity with the runbook and the
 * dashboard; the model underneath is now per-holder unit accounting rather
 * than a per-collection set of "tainted" tokenIds. See lib/passTaint.ts for
 * why that changed — the old form revoked every holder of an edition when one
 * of them sold off-platform.
 */

async function rateLimit(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-taint:${ip}`, 20, 60)
  return allowed ? null : errorResponse(429, 'Too many requests')
}

/** GET /api/admin/taint?address=0x… — the off-platform units recorded against
 *  one holder, as `{ tokenId: units }`. An empty object means the wallet is
 *  clean and its whole balance counts.
 *
 *  GET /api/admin/taint?legacy=1 — MIGRATION AID: the superseded token-scoped
 *  taint set. Nothing reads it any more; this is how an operator sees what the
 *  old model accumulated before clearing it with DELETE ?legacy=1.
 *  Admin-only. */
export async function GET(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const config = await getGateConfig()
  if (!config.passCollection) {
    return errorResponse(400, 'No pass collection configured')
  }

  if (req.nextUrl.searchParams.get('legacy')) {
    const tainted = await listLegacyTaintedTokenIds(config.passCollection)
    return NextResponse.json({
      collection: config.passCollection,
      legacy: true,
      tainted,
      note:
        'Superseded token-scoped taint set — no longer read by the gate. '
        + 'Clear with DELETE ?legacy=1 once reviewed.',
    })
  }

  const address = req.nextUrl.searchParams.get('address')
  if (!address || !isAddress(address)) {
    return errorResponse(400, 'address query param required (or ?legacy=1)')
  }

  const offPlatform = await listOffPlatformUnits(config.passCollection, address)
  return NextResponse.json({
    collection: config.passCollection,
    address: address.toLowerCase(),
    offPlatform,
  })
}

/** DELETE /api/admin/taint — clear a false off-platform mark.
 *
 *  Body `{ address, tokenId }`: the usual case. Use when a holder was marked
 *  in error — e.g. a legitimate Kismet secondary sale whose keyKismetListed
 *  flag was missing (Redis down at listing creation), which would otherwise
 *  discount the buyer's copy. Clearing it makes their balance countable again
 *  on the next gate decision; no credit replay is needed. A credit that was
 *  skipped for a DIFFERENT reason (blacklist, lost webhook) still needs
 *  POST /api/admin/pass-validity.
 *
 *  Body `{ legacy: true }`: MIGRATION — drop the superseded token-scoped taint
 *  set entirely. Safe once this model is live: no read path consults it, and
 *  the denials it carried for wallets that actually left the platform are
 *  already reflected in their zeroed ledgers.
 *
 *  Admin-only. */
export async function DELETE(req: NextRequest) {
  const limited = await rateLimit(req)
  if (limited) return limited

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    address?: string
    tokenId?: string
    legacy?: boolean
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const config = await getGateConfig()
  if (!config.passCollection) {
    return errorResponse(400, 'No pass collection configured')
  }

  if (body.legacy === true) {
    const cleared = await listLegacyTaintedTokenIds(config.passCollection)
    await clearLegacyTaint(config.passCollection)
    await recordAdminAction('taint.clear-legacy', {
      actor: auth.signer,
      target: config.passCollection,
      meta: { cleared },
    })
    return NextResponse.json({ ok: true, legacy: true, cleared })
  }

  if (!body.address || !isAddress(body.address)) {
    return errorResponse(400, 'Invalid address')
  }
  if (!body.tokenId || !/^\d+$/.test(body.tokenId)) {
    return errorResponse(400, 'tokenId must be a non-negative integer string')
  }
  // Canonicalize so clearing "01" can't leave "1" recorded (same tokenId,
  // different string forms — match the pattern used at ingest time).
  const tokenId = BigInt(body.tokenId).toString()
  const address = body.address.toLowerCase()

  await clearOffPlatformUnits(config.passCollection, address, tokenId)
  await recordAdminAction('taint.clear', {
    actor: auth.signer,
    target: address,
    meta: { collection: config.passCollection, tokenId },
  })
  return NextResponse.json({ ok: true, address, tokenId })
}
