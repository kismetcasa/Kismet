import { NextRequest, NextResponse, after } from 'next/server'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { acquireLock } from '@/lib/redisLock'
import { isPlatformPausedFor, getGateConfig } from '@/lib/gate'
import { isBlacklisted } from '@/lib/blacklist'
import { bestEffort } from '@/lib/bestEffort'
import { drawHash, epochFor, snapshotHash } from '@/lib/experience/fairness'
import { runDraw } from '@/lib/experience/runDraw'
import { MAX_UNITS_PER_CAPSULE } from '@/lib/experience/draw'
import { checkPrizeAuthority } from '@/lib/experience/authority'
import { deliverPrize, readPrizeBalance, reconcileDelivered } from '@/lib/experience/delivery'
import {
  advanceClaim,
  buildSnapshot,
  consumeOne,
  getClaim,
  getMachine,
  getPool,
  getRemaining,
  openEpochSeeds,
  publicClaim,
  releaseOne,
  seedForEpoch,
} from '@/lib/experience/store'
import type { ClaimRecord, SnapshotEntry } from '@/lib/experience/types'
import { writeNotification } from '@/lib/notifications'
import { recordCollected } from '@/lib/collected'
import { fetchArtworkMeta } from '@/lib/experience/artwork'
import { filterDeliverable, isDeliverableEntry } from '@/lib/experience/eligibility'

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
/** Sponsored broadcasts one claim may ever make. Low on purpose: past a couple
 *  of failures the cause is structural (a reverting adminMint, a paymaster that
 *  will not sponsor this collection) and further retries only spend gas. */
const MAX_DELIVERY_ATTEMPTS = 3
/** How long a claim must sit in a mid-flight state before resume will adopt it.
 *  Comfortably longer than the slowest legitimate play (a 200-entry freeze plus
 *  a 60s delivery wait) so a live request is never raced. */
const STALE_CLAIM_MS = 180_000

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
  if (unitIndex < 0 || unitIndex >= MAX_UNITS_PER_CAPSULE) return errorResponse(400, 'Invalid unitIndex')

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
    // Bound to a local: `claim` is reassigned by every advanceClaim below, which
    // widens it back and loses the narrowing this branch established. The prize
    // itself is fixed for the whole block — it is the copy already spent.
    const prize = claim.prize
    // The floor this claim's delivery must beat. Absent only on claims frozen
    // before the field existed; 0 reproduces the old behaviour, which errs
    // toward "already delivered" — the safe direction, since the alternative
    // is minting a second copy for one payment.
    const minBalance = claim.balanceBefore ?? 0
    // Only a claim that actually BROADCAST has anything to reconcile. Without
    // this, a claim whose delivery was refused outright (`unsponsored`, or CDP
    // unavailable — no userOp, nothing sent) was still measured against the
    // player's wallet, so any unrelated acquisition of that edition — collecting
    // it from its own page, an airdrop, a win on another machine — silently
    // discharged the obligation after the artist's copy had been consumed.
    const landed = claim.userOpHash
      ? await reconcileDelivered({
          collection: prize.collection,
          tokenId: prize.tokenId,
          player,
          minBalance,
        })
      : false
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

    // The exclusions the FREEZE applied, re-applied at the moment of delivery.
    // This is the path that runs latest — hours or days after the draw — so it
    // is the one most likely to be delivering something that has since been
    // hidden, blacklisted, or swept into the Pass collection by a gate
    // rotation. The copy is already spent either way; the choice is only
    // whether to also mint something the platform has decided must not be
    // minted.
    const gateNow = await getGateConfig()
    const deliverable = await isDeliverableEntry(prize, gateNow.passCollection?.toLowerCase() ?? null)
    if (!deliverable) {
      claim = await advanceClaim(claim, {
        state: 'pending',
        pendingReason: 'the drawn artwork is no longer eligible to be dispensed — an operator is looking at this capsule',
      })
      console.error('[xp] resume blocked by eligibility', { machineId, txHash, unitIndex })
      return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
    }

    const auth = await checkPrizeAuthority({
      collection: prize.collection,
      tokenId: prize.tokenId,
    })
    if (!auth.ok) {
      claim = await advanceClaim(claim, {
        state: 'pending',
        pendingReason: `the drawn artwork can no longer be minted (${auth.reason ?? 'unknown'})`,
      })
      return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
    }

    // Every broadcast is gas the platform pays. A prize whose adminMint reverts
    // while the authority reads look healthy would otherwise retry on every
    // resume, forever, at the paymaster's expense.
    const attempts = claim.deliveryAttempts ?? 0
    if (attempts >= MAX_DELIVERY_ATTEMPTS) {
      claim = await advanceClaim(claim, {
        state: 'pending',
        pendingReason: 'delivery has failed repeatedly — an operator is looking at this capsule',
      })
      console.error('[xp] delivery attempts exhausted', { machineId, txHash, unitIndex })
      return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
    }
    claim = await advanceClaim(claim, { state: claim.state, deliveryAttempts: attempts + 1 })

    const outcome = await deliverPrize({
      collection: prize.collection,
      tokenId: prize.tokenId,
      player,
      operator: auth.operator,
      onBroadcast: async (userOpHash) => {
        claim = await advanceClaim(claim, { state: 'sending', userOpHash })
      },
    })
    claim = await applyOutcome(claim, outcome, player, minBalance)
    if (claim.state === 'delivered') await settle(claim, machineId)
    return NextResponse.json({
      ok: true,
      claim: publicClaim(claim),
      resumed: claim.state === 'delivered',
    })
  }

  // ── Case 2: nothing was ever drawn (the pool had nothing deliverable).
  //
  //    `pending` is the ONLY state that means the draw finished and found
  //    nothing. `claimed` and `frozen` mean a /api/experience/play request is
  //    still working — its freeze walks up to MAX_POOL_ENTRIES hidden and
  //    blacklist checks before it persists a prize, and resuming inside that
  //    window would run a SECOND draw against the same claim, consume a second
  //    copy of some artist's edition, and deliver a second artwork for one
  //    capsule. The per-claim lock above excludes concurrent resumes; it does
  //    not exclude the play route, which never takes it.
  //    'claimed' and 'frozen' normally mean a play is mid-flight — but they are
  //    also where a play that DIED mid-freeze comes to rest, and the claim is
  //    the obligation. Refusing them outright would make an interrupted play a
  //    permanent loss of a paid capsule. So they are recoverable, but only once
  //    they are older than any live request could plausibly be: the freeze walks
  //    up to MAX_POOL_ENTRIES sequential Redis and RPC round trips, and the
  //    delivery wait alone is bounded at 60s.
  if (claim.state !== 'pending') {
    const age = Date.now() - claim.createdAt
    const abandoned =
      (claim.state === 'claimed' || claim.state === 'frozen') && age > STALE_CLAIM_MS
    if (!abandoned) {
      return NextResponse.json({
        ok: true,
        claim: publicClaim(claim),
        resumed: false,
        reason: 'this capsule is still being opened — check back in a moment',
      })
    }
    console.warn('[xp] adopting an abandoned claim', { machineId, txHash, unitIndex, state: claim.state, age })
  }

  //    The player is still owed an artwork, so draw again over the pool AS IT IS NOW.
  //
  //    This re-freezes against the CURRENT epoch, not the original. That is not
  //    a shortcut: the original epoch may already have closed and had its seed
  //    revealed, and drawing against a public seed would make the outcome
  //    predictable by anyone watching. A genuinely new draw gets a genuinely
  //    secret seed, and the claim records the new epoch, snapshot and commitment
  //    so the receipt still verifies end to end.
  // Case 1 above settles a prize already drawn, on any machine state — that copy
  // is spent and the player is owed it. A NEW draw is different: a delisted
  // machine has had its supply pledges released, so drawing now could issue a
  // copy another machine is already counting on.
  if (machine.state === 'draft' || machine.state === 'review' || machine.state === 'delisted') {
    return errorResponse(403, 'Machine is not live')
  }

  const gate = await getGateConfig()
  const passCollection = gate.passCollection?.toLowerCase() ?? null
  const rawSnapshot = buildSnapshot(await getPool(machineId), await getRemaining(machineId))
  const eligible: SnapshotEntry[] = await filterDeliverable(rawSnapshot, passCollection)

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

  const freshFloor = await readPrizeBalance({
    collection: prize.collection,
    tokenId: prize.tokenId,
    player,
  })
  if (freshFloor === null) {
    claim = await advanceClaim(claim, {
      state: 'pending',
      pendingReason: 'could not read your wallet before delivery — this capsule is safe and will be honoured',
    })
    return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: false })
  }
  claim = await advanceClaim(claim, {
    state: 'drawn',
    balanceBefore: freshFloor,
    deliveryAttempts: (claim.deliveryAttempts ?? 0) + 1,
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
  claim = await applyOutcome(claim, outcome, player, freshFloor)
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
  minBalance: number,
): Promise<ClaimRecord> {
  if (outcome.kind === 'delivered') {
    return advanceClaim(claim, { state: 'delivered', txDelivered: outcome.txHash })
  }
  if (outcome.kind === 'indeterminate' && claim.prize) {
    const landed = await reconcileDelivered({
      collection: claim.prize.collection,
      tokenId: claim.prize.tokenId,
      player,
      minBalance,
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
