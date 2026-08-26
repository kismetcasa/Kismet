import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { verifyAdminSession } from '@/lib/curator'
import { parseWei } from '@/lib/giftFund'
import {
  claimContributionTx,
  getCampaign,
  recordContribution,
} from '@/lib/giftFundStore'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { recordAdminAction } from '@/lib/adminAudit'

/**
 * Admin remediation for the Gift Fund: manually credit a contribution the
 * automatic verifier cannot reach.
 *
 * The claim route's two tiers cover EOA plain sends and EntryPoint-routed
 * smart-wallet sends. Real transfers outside both DO exist — an EIP-7702
 * account self-executing a batch (no UserOperationEvent to bind), or a claim
 * arriving while the RPC's debug tier is unavailable (the 501 path). In
 * those cases the money reached the organizer but the credit was refused —
 * the one shape where a backer loses something — and this is the recourse.
 *
 * Trust model: verifyAdminSession, and the ADMIN is the verifier — this
 * route intentionally does not re-run on-chain checks, because it exists
 * precisely for the shapes those checks cannot express. It writes through
 * the SAME primitives as the automatic path: the global one-tx-one-campaign
 * NX claim (so it can never double-credit a tx the verifier already
 * accepted, and a later automatic claim of the same tx no-ops), then
 * recordContribution. Every use is audit-logged with the full tuple.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`admin-gift-fund:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const auth = await verifyAdminSession()
  if ('error' in auth) return errorResponse(auth.status, auth.error)

  const body = (await req.json().catch(() => null)) as {
    campaignId?: string
    txHash?: string
    backer?: string
    amountWei?: string
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const { campaignId, txHash, backer } = body
  if (!campaignId || !/^0x[0-9a-fA-F]{64}$/.test(campaignId)) {
    return errorResponse(400, 'Invalid campaignId')
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return errorResponse(400, 'Invalid txHash')
  }
  if (!backer || !isAddress(backer)) return errorResponse(400, 'Invalid backer')
  const amountWei = parseWei(body.amountWei)
  if (amountWei <= 0n) return errorResponse(400, 'Invalid amountWei')

  const campaign = await getCampaign(campaignId)
  if (!campaign) return errorResponse(404, 'No such campaign')
  if (backer.toLowerCase() === campaign.organizer.toLowerCase()) {
    return errorResponse(400, 'Organizer cannot be credited as a backer')
  }

  const claimed = await claimContributionTx(txHash)
  if (!claimed) return NextResponse.json({ ok: true, idempotent: true })

  await recordContribution({
    giftTx: campaignId,
    contribTx: txHash,
    backer: backer.toLowerCase(),
    amountWei,
    blockTimestampMs: Date.now(),
  })
  await recordAdminAction('gift-fund.credit', {
    actor: auth.signer,
    target: backer.toLowerCase(),
    meta: { campaignId, txHash, amountWei: amountWei.toString() },
  })
  return NextResponse.json({ ok: true })
}
