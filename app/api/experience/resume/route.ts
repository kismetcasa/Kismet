import { NextRequest, NextResponse, after } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { acquireLock } from '@/lib/redisLock'
import { isPlatformPausedFor, getGateConfig } from '@/lib/gate'
import { isBlacklisted } from '@/lib/blacklist'
import { bestEffort } from '@/lib/bestEffort'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { drawHash, epochFor, snapshotHash } from '@/lib/experience/fairness'
import { runDraw } from '@/lib/experience/runDraw'
import { checkPrizeAuthority } from '@/lib/experience/authority'
import { deliverPrize, reconcileDelivered } from '@/lib/experience/delivery'
import {
  advanceClaim,
  buildSnapshot,
  consumeOne,
  getClaim,
  getMachine,
  getPool,
  getRemaining,
  openEpochSeeds,
  releaseOne,
  seedForEpoch,
} from '@/lib/experience/store'
import type { ClaimRecord, SnapshotEntry } from '@/lib/experience/types'
import { writeNotification } from '@/lib/notifications'
import { recordCollected } from '@/lib/collected'
import { fetchArtworkMeta } from '@/lib/experience/artwork'

/**
 * Finish a claim that stalled.
 *
 * ── Why this route has to exist ──
 *
 * /api/experience/play is one request spanning a wallet transaction, a draw and
 * a sponsored mint, and any of the last steps can end without a delivery: a
 * paymaster refusal, a userOp that times out with no verdict, or a pool with
 * nothing drawable at that instant. In every one of those the player HAS PAID
 * and is owed an artwork, and the claim parks in `pending` or `sending`.
 * Without this route that obligation had no discharge short of a manual
 * operator write — the state machine had states it could never leave.
 *
 * ── Authorisation ──
 *
 * Deliberately none beyond the rate limit. The claim names its own `claimant`
 * and delivery always mints to THAT address, never to the caller, so a stranger
 * invoking this can only cause the rightful owner to be paid. Requiring a
 * session would strand precisely the person most likely to need it: someone who
 * changed device or cleared storage after paying.
 *
 * ── The one rule ──
 *
 * NEVER re-mint on an unknown. Every path holding a prize asks the chain first
 * and mints only on a definitive zero balance. Blind retry is the single action
 * that turns one payment into two artworks.
 */

const MAX_ATTEMPTS = 6

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-resume:${ip}`, 20, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as {
    machineId?: string
    txHash?: string
    unitIndex?: number
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const machineId = typeof body.machineId === 'string' ? body.machineId : ''
  const txHash = body.txHash
  const unitIndex = Number.isInteger(body.unitIndex) ? Number(body.unitIndex) : 0

  if (!machineId || !/^[a-z0-9-]{3,64}$/.test(machineId)) return errorResponse(400, 'Invalid machineId')
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return errorResponse(400, 'Invalid txHash')
  if (unitIndex < 0 || unitIndex > 999) return errorResponse(400, 'Invalid unitIndex')

  // ── Single-flight per claim, and this is load-bearing ──
  //
  // /api/experience/play is protected by its own `createClaim` NX: exactly one
  // request ever draws for a given unit. Resume has no such guard, and Case 2
  // below DRAWS. Two concurrent resumes on an undrawn claim would each select a
  // prize, each consume a copy, and each deliver — two artworks for one payment,
  // and the two deliveries would not even collide on delivery.ts's own lock
  // because they are different tokens. The lock has to be on the CLAIM.
  const gate = await acquireLock(
    `kismetart:xp:resume:${machineId}:${txHash.toLowerCase()}:${unitIndex}`,
    90,
  ).catch(() => ({ acquired: false, release: async () => {} }))
  if (!gate.acquired) {
    return NextResponse.json({
      ok: true,
      resumed: false,
      reason: 'this capsule is already being opened — check back in a moment',
    })
  }

  try {
    return await handle(machineId, txHash, unitIndex)
  } finally {
    await gate.release()
  }
}

async function handle(
  machineId: string,
  txHash: string,
  unitIndex: number,
): Promise<NextResponse> {
  const found = await getClaim(machineId, txHash, unitIndex)
  if (!found) return errorResponse(404, 'No such play')
  // Bound to a non-nullable local: the `onBroadcast` closures below reassign
  // `claim`, which would otherwise widen it back to `ClaimRecord | null` at
  // every later use and force a null check that cannot actually be reached.
  let claim: ClaimRecord = found
  if (claim.state === 'delivered') {
    return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
  }

  const player = claim.claimant
  // A blacklisted claimant is not paid out, but the claim is NOT destroyed —
  // it stays exactly as it is, so the decision stays reversible.
  if (await isBlacklisted(player).catch(() => true)) return errorResponse(403, 'Not permitted')
  if (await isPlatformPausedFor(player)) return errorResponse(503, 'Platform is paused')

  const machine = await getMachine(machineId)
  if (!machine) return errorResponse(404, 'Machine not found')

  // ── Case 1: a prize was already drawn. The copy is spent, so deliver THAT
  //    piece or nothing. Re-drawing would consume a second copy for one payment.
  if (claim.prize) {
    const landed = await reconcileDelivered({
      collection: claim.prize.collection,
      tokenId: claim.prize.tokenId,
      player,
    })
    if (landed === true) {
      claim = await advanceClaim(claim, { state: 'delivered' })
      await settle(claim, machineId)
      return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: true })
    }
    if (landed === null) {
      // The chain could not answer. Pending is the only safe verdict — minting
      // on an unknown is how one payment becomes two artworks.
      return NextResponse.json({
        ok: true,
        claim: publicClaim(claim),
        resumed: false,
        reason: 'could not read chain state — try again shortly',
      })
    }

    const auth = await checkPrizeAuthority({
      collection: claim.prize.collection,
      tokenId: claim.prize.tokenId,
    })
    if (!auth.ok) {
      claim = await advanceClaim(claim, {
        state: 'pending',
        pendingReason: `the drawn artwork can no longer be minted (${auth.reason ?? 'unknown'})`,
      })
      return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
    }

    const outcome = await deliverPrize({
      collection: claim.prize.collection,
      tokenId: claim.prize.tokenId,
      player,
      operator: auth.operator,
      onBroadcast: async (userOpHash) => {
        claim = await advanceClaim(claim, { state: 'sending', userOpHash })
      },
    })
    claim = await applyOutcome(claim, outcome, player)
    if (claim.state === 'delivered') await settle(claim, machineId)
    return NextResponse.json({
      ok: true,
      claim: publicClaim(claim),
      resumed: claim.state === 'delivered',
    })
  }

  // ── Case 2: nothing was ever drawn (the pool had nothing deliverable). The
  //    player is still owed an artwork, so draw again over the pool AS IT IS NOW.
  //
  //    This re-freezes against the CURRENT epoch, not the original. That is not
  //    a shortcut: the original epoch may already have closed and had its seed
  //    revealed, and drawing against a public seed would make the outcome
  //    predictable by anyone watching. A genuinely new draw gets a genuinely
  //    secret seed, and the claim records the new epoch, snapshot and commitment
  //    so the receipt still verifies end to end.
  if (machine.state === 'draft' || machine.state === 'review') {
    return errorResponse(403, 'Machine is not live')
  }

  const gate = await getGateConfig()
  const passCollection = gate.passCollection?.toLowerCase() ?? null
  const rawSnapshot = buildSnapshot(await getPool(machineId), await getRemaining(machineId))
  const eligible: SnapshotEntry[] = []
  for (const e of rawSnapshot) {
    if (passCollection && e.collection.toLowerCase() === passCollection) continue
    if (await isMomentHidden(e.collection, e.tokenId).catch(() => true)) continue
    if (await isBlacklisted(e.artist).catch(() => true)) continue
    eligible.push(e)
  }

  const epoch = epochFor(Date.now())
  const { seed } = await seedForEpoch(machineId, epoch)
  const { commitment } = await openEpochSeeds(machineId, epoch)
  claim = await advanceClaim(claim, {
    state: 'frozen',
    snapshot: eligible,
    snapshotHash: snapshotHash(eligible),
    epoch,
    commitment,
  })

  let grantedOperator: string | undefined
  const result = await runDraw(
    eligible,
    {
      consume: (key) => consumeOne(machineId, key),
      release: (key) => releaseOne(machineId, key),
      authority: async (e) => {
        const r = await checkPrizeAuthority({ collection: e.collection, tokenId: e.tokenId })
        if (r.ok) grantedOperator = r.operator
        return r.ok
      },
      hash: (attempt) => drawHash({ serverSeed: seed, txHash, unitIndex, attempt }),
    },
    MAX_ATTEMPTS,
  )

  if (result.kind !== 'drawn') {
    claim = await advanceClaim(claim, {
      state: 'pending',
      attempt: result.attempt,
      pendingReason: 'no eligible artwork available yet — this capsule stays owed',
    })
    return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
  }

  const prize = result.prize
  claim = await advanceClaim(claim, {
    state: 'drawn',
    attempt: result.attempt,
    prize: { collection: prize.collection, tokenId: prize.tokenId, artist: prize.artist },
  })

  const outcome = await deliverPrize({
    collection: prize.collection,
    tokenId: prize.tokenId,
    player,
    operator: grantedOperator,
    onBroadcast: async (userOpHash) => {
      claim = await advanceClaim(claim, { state: 'sending', userOpHash })
    },
  })
  claim = await applyOutcome(claim, outcome, player)
  if (claim.state === 'delivered') await settle(claim, machineId)

  return NextResponse.json({
    ok: true,
    claim: publicClaim(claim),
    resumed: claim.state === 'delivered',
  })
}

/** Fold a delivery outcome into the claim. Identical to the play route's
 *  handling, deliberately — a resumed delivery must reach exactly the same
 *  states as a first-attempt one, or the two paths drift apart. */
async function applyOutcome(
  claim: ClaimRecord,
  outcome: Awaited<ReturnType<typeof deliverPrize>>,
  player: string,
): Promise<ClaimRecord> {
  if (outcome.kind === 'delivered') {
    return advanceClaim(claim, { state: 'delivered', txDelivered: outcome.txHash })
  }
  if (outcome.kind === 'indeterminate' && claim.prize) {
    const landed = await reconcileDelivered({
      collection: claim.prize.collection,
      tokenId: claim.prize.tokenId,
      player,
    })
    return landed === true
      ? advanceClaim(claim, { state: 'delivered' })
      : advanceClaim(claim, {
          state: 'pending',
          pendingReason: 'delivery submitted but unconfirmed — reconciling',
        })
  }
  return advanceClaim(claim, {
    state: 'pending',
    pendingReason:
      outcome.kind === 'unsponsored'
        ? 'delivery could not be sponsored'
        : outcome.kind === 'reverted'
          ? 'delivery reverted on-chain'
          : 'delivery unavailable',
  })
}

/** The non-critical bookkeeping a delivery owes. Deferred, and every leg
 *  swallows its own failure — none of it is the artwork, which is already
 *  on-chain by the time this runs. */
async function settle(claim: ClaimRecord, machineId: string): Promise<void> {
  const prize = claim.prize
  if (!prize) return
  const claimant = claim.claimant
  const tx = claim.txHash
  after(async () => {
    await recordCollected(claimant, prize.collection, prize.tokenId).catch(() => {})
    const meta = await fetchArtworkMeta(prize.collection, prize.tokenId)
    await writeNotification({
      type: 'experience_win',
      recipient: claimant,
      actor: prize.artist,
      tokenAddress: prize.collection,
      tokenId: prize.tokenId,
      tokenName: meta?.name ?? undefined,
      tokenImage: meta?.image ?? undefined,
      amount: 1,
    }).catch(bestEffort('xp.resumeNotify', { machineId, txHash: tx }))
  })
}

function publicClaim(c: ClaimRecord) {
  return {
    state: c.state,
    prize: c.prize ?? null,
    attempt: c.attempt ?? 0,
    epoch: c.epoch ?? null,
    commitment: c.commitment ?? null,
    snapshotHash: c.snapshotHash ?? null,
    unitIndex: c.unitIndex,
    pendingReason: c.pendingReason ?? null,
    txDelivered: c.txDelivered ?? null,
  }
}
