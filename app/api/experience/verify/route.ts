import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { epochFor, verifyDraw } from '@/lib/experience/fairness'
import { selectByHash } from '@/lib/experience/draw'
import { commitmentForEpoch, getClaim, revealSeed } from '@/lib/experience/store'

/**
 * Public verification of a past draw.
 *
 * This is the entire point of committing anything: a player (or anyone) can
 * take a finished play and prove the machine did not choose the outcome after
 * seeing their transaction. The endpoint returns the material and ALSO does the
 * recomputation server-side, so the honest path is one click — but everything
 * needed to redo it independently is in the response, which is what makes the
 * claim checkable rather than trusted.
 *
 * Both halves are verified, and the second is the one the industry omits:
 *   1. the revealed seed hashes to the commitment published in advance;
 *   2. the snapshot hashes to the weight table committed at freeze.
 * Skipping (2) is exactly how "provably fair" has been shipped over rigged
 * tables — every individual draw verifies while the odds change underneath.
 *
 * A seed is revealed only after its epoch closes. Revealing a live seed would
 * make every remaining draw in that epoch predictable, which would turn a
 * fairness feature into an exploit.
 */
export async function GET(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-verify:${ip}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const url = new URL(req.url)
  const machineId = url.searchParams.get('machineId') ?? ''
  const txHash = url.searchParams.get('txHash') ?? ''
  const unitIndex = Number(url.searchParams.get('unitIndex') ?? '0')

  if (!/^[a-z0-9-]{3,64}$/.test(machineId)) return errorResponse(400, 'Invalid machineId')
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return errorResponse(400, 'Invalid txHash')
  if (!Number.isInteger(unitIndex) || unitIndex < 0 || unitIndex > 999) {
    return errorResponse(400, 'Invalid unitIndex')
  }

  const claim = await getClaim(machineId, txHash, unitIndex)
  if (!claim) return errorResponse(404, 'No such play')
  if (!claim.snapshot || !claim.snapshotHash || !claim.epoch) {
    return errorResponse(409, 'This play has not been drawn yet')
  }

  const currentEpoch = epochFor(Date.now())
  const seed = await revealSeed(machineId, claim.epoch, currentEpoch)
  if (!seed) {
    // Not an error — the play is simply still inside its epoch. Return the
    // material that IS public so a player can pre-check the commitment now and
    // finish the verification once the epoch closes.
    return NextResponse.json({
      verifiable: false,
      reason: 'the seed for this play has not been revealed yet',
      revealsAfter: claim.epoch,
      epoch: claim.epoch,
      commitment: claim.commitment ?? (await commitmentForEpoch(machineId, claim.epoch)),
      snapshotHash: claim.snapshotHash,
      snapshot: claim.snapshot,
      attempt: claim.attempt ?? 0,
      prize: claim.prize ?? null,
    })
  }

  // The commitment must be the one this play was SERVED under, recorded on the
  // claim at freeze — not one recomputed from the seed we are revealing. Hashing
  // the revealed seed and comparing it to itself is a tautology that passes for
  // any seed whatsoever, which would quietly reduce this endpoint to checking
  // only the weight table. Claims frozen before `commitment` was recorded fall
  // back to the epoch's stored commitment, which is still an independent read.
  const commitment = claim.commitment ?? (await commitmentForEpoch(machineId, claim.epoch))
  if (!commitment) {
    return NextResponse.json({
      verifiable: false,
      reason: 'no published commitment was recorded for this play',
      epoch: claim.epoch,
    })
  }

  const result = verifyDraw({
    serverSeed: seed,
    commitment,
    snapshot: claim.snapshot,
    snapshotHash: claim.snapshotHash,
    txHash: claim.txHash,
    unitIndex: claim.unitIndex,
    attempt: claim.attempt ?? 0,
  })
  if (!result.ok || !result.hash) {
    return NextResponse.json({ verifiable: true, ok: false, reason: result.reason })
  }

  // Recompute the selection from the revealed material and compare it to what
  // was actually delivered. A mismatch would be the single most serious defect
  // this system could have, so it is surfaced plainly rather than smoothed over.
  const recomputed = selectByHash(claim.snapshot, result.hash)
  const matches =
    !!recomputed &&
    !!claim.prize &&
    recomputed.collection === claim.prize.collection &&
    recomputed.tokenId === claim.prize.tokenId

  return NextResponse.json({
    verifiable: true,
    ok: matches,
    epoch: claim.epoch,
    serverSeed: seed,
    commitment,
    snapshotHash: claim.snapshotHash,
    snapshot: claim.snapshot,
    txHash: claim.txHash,
    unitIndex: claim.unitIndex,
    attempt: claim.attempt ?? 0,
    drawHash: result.hash,
    recomputed: recomputed ? { collection: recomputed.collection, tokenId: recomputed.tokenId } : null,
    delivered: claim.prize ?? null,
  })
}
