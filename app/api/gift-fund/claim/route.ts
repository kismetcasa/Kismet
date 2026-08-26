import { NextRequest, NextResponse, after } from 'next/server'
import type { Hex } from 'viem'
import { errorResponse } from '@/lib/apiResponse'
import {
  campaignStatus,
  claimWindowOpen,
  evaluateReceiptTransfer,
  evaluateTracedTransfer,
  MIN_CONTRIBUTION_WEI,
  parseWei,
  progressPercent,
  transferWithinWindow,
  type TracedCall,
} from '@/lib/giftFund'
import {
  claimContributionTx,
  getCampaign,
  recordContribution,
} from '@/lib/giftFundStore'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { serverBaseClient } from '@/lib/rpc'
import { userOpSendersFromLogs } from '@/lib/userOps'

/**
 * Claim a contribution: bind an on-chain ETH transfer to a campaign.
 *
 * UNAUTHENTICATED BY DESIGN. The backer is DERIVED from the chain (the
 * transfer's proven sender), never from the body — so there is nothing to
 * spoof and no session to require; a third party submitting someone else's
 * transfer merely surfaces a real contribution, correctly attributed. Same
 * posture as /api/collect, the platform's most battle-tested route.
 *
 * Two verification tiers (rules and rationale in lib/giftFund):
 *   1. RECEIPT — tx.to IS the organizer (every EOA wallet's plain send).
 *   2. TRACE — for smart-wallet sends (top-level tx goes to the EntryPoint):
 *      internal calls, credited only when a call's sender is the receipt's
 *      UserOperationEvent sender. Trace source is debug_traceTransaction on
 *      the configured RPC; when the plan doesn't expose it, the claim fails
 *      with a distinct message rather than silently rejecting the backer.
 */

// callTracer frame: nested calls, hex value. Only the fields we read.
interface TraceFrame {
  type?: string
  from?: string
  to?: string
  value?: string
  calls?: TraceFrame[]
}

// ONLY type CALL moves ETH. DELEGATECALL and CALLCODE execute foreign code in
// the caller's context and can carry an inherited `value` field while
// transferring NOTHING — a smart account delegatecalling the organizer's EOA
// address would produce a frame {from: account, to: organizer, value: X} with
// no ETH moved, i.e. a free fake contribution if counted. SELFDESTRUCT can
// move real value but its `from` is the destructed contract, never a userOp
// sender, so excluding it only under-credits (the safe direction). The root
// frame of any tx is type CALL, so the EOA-shaped case is unaffected.
function flattenValueCalls(frame: TraceFrame, out: TracedCall[]): TracedCall[] {
  const value = frame.value ? BigInt(frame.value) : 0n
  if (frame.type === 'CALL' && frame.from && frame.to && value > 0n) {
    out.push({ from: frame.from, to: frame.to, valueWei: value })
  }
  for (const sub of frame.calls ?? []) flattenValueCalls(sub, out)
  return out
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  // Tighter than most routes: each claim can cost up to three RPC reads and
  // (for smart wallets) a debug trace.
  const allowed = await checkRateLimit(`gift-fund-claim:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = (await req.json().catch(() => null)) as {
    campaignId?: string
    txHash?: string
  } | null
  if (!body) return errorResponse(400, 'Invalid body')
  const { campaignId, txHash } = body
  if (!campaignId || !/^0x[0-9a-fA-F]{64}$/.test(campaignId)) {
    return errorResponse(400, 'Invalid campaignId')
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return errorResponse(400, 'Invalid txHash')
  }

  const campaign = await getCampaign(campaignId)
  if (!campaign) return errorResponse(404, 'No such campaign')
  if (!claimWindowOpen({ closesAtMs: campaign.closesAtMs, nowMs: Date.now() })) {
    return errorResponse(410, 'Claim window has closed')
  }

  const client = serverBaseClient()
  let tx, receipt
  try {
    ;[tx, receipt] = await Promise.all([
      client.getTransaction({ hash: txHash as Hex }),
      client.getTransactionReceipt({ hash: txHash as Hex }),
    ])
  } catch {
    // Not indexed yet (the client retries) or not a real tx.
    return errorResponse(404, 'Transaction not found')
  }
  if (receipt.status !== 'success') return errorResponse(400, 'Transaction reverted')

  // Tier 1: the plain-send shape.
  let verified = evaluateReceiptTransfer({
    txFrom: tx.from,
    txTo: tx.to,
    valueWei: tx.value,
    organizer: campaign.organizer,
  })

  // Distinct dust verdict: a real plain send below the minimum must not fall
  // through to the trace tier and come back as "does not pay the organizer" —
  // the money DID arrive; only the credit is refused, and the message says so.
  if (
    !verified &&
    tx.to &&
    tx.to.toLowerCase() === campaign.organizer.toLowerCase() &&
    tx.value > 0n &&
    tx.value < MIN_CONTRIBUTION_WEI
  ) {
    return errorResponse(422, 'Below the minimum contribution (0.0001 ETH)')
  }

  // Tier 2: smart-wallet internal calls, gated on the userOp-sender binding.
  if (!verified) {
    const userOpSenders = userOpSendersFromLogs(receipt.logs)
    if (userOpSenders.length === 0) {
      return errorResponse(422, 'Transaction does not pay the organizer')
    }
    let frame: TraceFrame
    try {
      frame = (await client.request({
        // Not in viem's typed RPC schema — a debug-namespace method.
        method: 'debug_traceTransaction' as never,
        params: [txHash, { tracer: 'callTracer' }] as never,
      })) as TraceFrame
    } catch {
      // The RPC plan doesn't expose debug tracing. Distinct message so the
      // client can tell "not supported yet" from "not a contribution" — and
      // so ops knows exactly which knob unblocks smart-wallet backers.
      return errorResponse(501, 'Smart-wallet verification unavailable')
    }
    verified = evaluateTracedTransfer({
      calls: flattenValueCalls(frame, []),
      userOpSenders,
      organizer: campaign.organizer,
    })
  }
  if (!verified) return errorResponse(422, 'Transaction does not pay the organizer')

  // The organizer's own money round-tripping is not backing.
  if (verified.backer === campaign.organizer.toLowerCase()) {
    return errorResponse(422, 'Organizer cannot back their own fund')
  }

  // Transfer-time window (claim-time grace already checked above).
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  const blockTimestampMs = Number(block.timestamp) * 1000
  if (
    !transferWithinWindow({
      blockTimestampMs,
      openedAtMs: campaign.openedAtMs,
      closesAtMs: campaign.closesAtMs,
    })
  ) {
    return errorResponse(422, 'Transfer is outside the campaign window')
  }

  // Global one-tx-one-campaign claim — AFTER verification (an invalid claim
  // must not burn the slot for the real one), NX so a client retry or a
  // concurrent duplicate resolves to one credit.
  const claimed = await claimContributionTx(txHash)
  if (!claimed) return NextResponse.json({ ok: true, idempotent: true })

  await recordContribution({
    giftTx: campaignId,
    contribTx: txHash,
    backer: verified.backer,
    amountWei: verified.amountWei,
    blockTimestampMs,
  })

  const amountWei = verified.amountWei
  const backer = verified.backer
  after(async () => {
    try {
      const meta = await getMomentMeta(campaign.collection, campaign.tokenId)
      await writeNotification({
        type: 'contribution',
        recipient: campaign.organizer,
        actor: backer,
        tokenAddress: campaign.collection,
        tokenId: campaign.tokenId,
        ...(meta?.name ? { tokenName: meta.name } : {}),
        price: amountWei.toString(),
        currency: 'eth',
      })
    } catch {
      // notifications are non-critical
    }
  })

  const updated = await getCampaign(campaignId)
  const raised = parseWei(updated?.raisedWei ?? campaign.raisedWei)
  const goal = parseWei(campaign.goalWei)
  return NextResponse.json({
    ok: true,
    raisedWei: raised.toString(),
    progressPercent: progressPercent(raised, goal),
    status: campaignStatus({
      raisedWei: raised,
      goalWei: goal,
      closesAtMs: campaign.closesAtMs,
      nowMs: Date.now(),
    }),
  })
}
