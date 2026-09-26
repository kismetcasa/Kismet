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
import { deliverPrize, readDeliveryOutcome } from '@/lib/experience/delivery'
import {
  CLAIM_LOCK_TTL_SECONDS,
  advanceClaim,
  buildSnapshot,
  claimLockKey,
  consumeOne,
  getClaim,
  getMachine,
  getPool,
  getRemaining,
  openEpochSeeds,
  publicClaim,
  releaseOne,
  seedForEpoch,
  settleDeliveredCopy,
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
 * NEVER re-mint on an unknown. Every path holding a prize that was broadcast
 * asks CDP what became of THAT userOp first, and mints again only when it is
 * definitively failed (or was never sent). Blind retry is the single action
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
  // Case 2 below DRAWS and both cases deliver, so two requests on one claim —
  // two resumes, or a resume and the play that created it — could each consume
  // a copy and each mint, two artworks for one payment. The play route holds
  // this same lock from the moment it creates the claim until it responds, so
  // nothing here can overlap it. See store.claimLockKey for the TTL.
  const gate = await acquireLock(claimLockKey(machineId, txHash, unitIndex), CLAIM_LOCK_TTL_SECONDS)
    .catch(() => ({ acquired: false, release: async () => {} }))
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
    // A claim that BROADCAST is asked about by its own userOp hash — the one
    // handle nothing else can move. (An earlier version measured the player's
    // balance of the edition against a floor; a sibling unit's mint of the
    // same floor piece satisfied it, and this unit was closed as delivered
    // having minted nothing. See lib/experience/delivery.) A claim that never
    // broadcast — sponsorship refused, CDP unavailable — has nothing to ask
    // and falls straight through to a fresh attempt under the caps below.
    if (claim.userOpHash) {
      const receipt = await readDeliveryOutcome({ userOpHash: claim.userOpHash })
      if (receipt.kind === 'landed') {
        claim = await advanceClaim(claim, { state: 'delivered', txDelivered: receipt.txHash })
        await settle(claim, machineId)
        return NextResponse.json({ ok: true, claim: publicClaim(claim), resumed: true })
      }
      if (receipt.kind === 'pending') {
        // Still in flight. The first mint may yet land, so a second one is the
        // one action that turns a payment into two artworks. Wait.
        return NextResponse.json({
          ok: true,
          claim: publicClaim(claim),
          resumed: false,
          reason: 'delivery is still confirming — try again shortly',
        })
      }
      if (receipt.kind === 'unknown') {
        // CDP could not answer. Pending is the only safe verdict — minting on
        // an unknown is how one payment becomes two artworks.
        return NextResponse.json({
          ok: true,
          claim: publicClaim(claim),
          resumed: false,
          reason: 'could not read delivery state — try again shortly',
        })
      }
      // `failed`: the broadcast reverted or was dropped, so nothing landed and
      // the obligation is still open. Fall through to a fresh attempt, under
      // the same eligibility, authority and attempt caps as any other.
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
      claimKey: `${machineId}:${claim.txHash}:${unitIndex}`,
      collection: prize.collection,
      tokenId: prize.tokenId,
      player,
      onBroadcast: async (userOpHash) => {
        claim = await advanceClaim(claim, { state: 'sending', userOpHash })
      },
    })
    claim = await applyOutcome(claim, outcome)
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
  //    nothing. `claimed` and `frozen` mean a play created the claim and has
  //    not finished drawing. Holding the claim lock means no live play holds
  //    it too, but a play that outran the lock's TTL could still be working, so
  //    those states are adopted only once they are older than any live request
  //    could plausibly be. They are also where a play that DIED mid-freeze comes
  //    to rest, and the claim is the obligation: refusing them outright would
  //    make an interrupted play a permanent loss of a paid capsule.
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
  //    Deliberately NOT gated on machine.state, and this is the fix for a real
  //    way a paid capsule could be stranded forever. Delisting used to refuse
  //    here, so every unopened capsule someone had already paid for on that
  //    machine became unrecoverable the moment a curator acted — the player's
  //    money gone with no artwork and no path to one.
  //
  //    A claim is an obligation already incurred: /api/experience/play only
  //    creates one after proving a capsule mint that PAID for it, so by the time
  //    anything reaches here the money has moved. State is a shelf decision and
  //    it cannot unwind that. `draft` and `review` never sold a capsule at all
  //    (play refuses them), so no claim can exist on one; every other state is a
  //    machine that took someone's money and owes them an artwork.
  //
  //    What actually protects the draw is per-artwork and still runs in full:
  //    filterDeliverable re-applies the hidden / blacklisted-artist / Pass
  //    exclusions below, checkPrizeAuthority re-checks the grant on chain, and
  //    delisting deliberately keeps BOTH the machine's supply pledges and its
  //    capsule token (see the admin route and store.reserveCapsule) precisely so
  //    these copies stay reserved and no rival machine can promise them or
  //    honour the same capsule mint. A curator who wants a specific piece to
  //    stop being dispensed hides it or blacklists its artist; that empties the
  //    eligible set and the claim pends instead of drawing. Refusing wholesale
  //    bought nothing those checks do not already cover.
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

  const result = await runDraw(
    eligible,
    {
      consume: (key) => consumeOne(machineId, key),
      release: (key) => releaseOne(machineId, key),
      authority: async (e) => (await checkPrizeAuthority({ collection: e.collection, tokenId: e.tokenId })).ok,
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

  claim = await advanceClaim(claim, {
    state: 'drawn',
    deliveryAttempts: (claim.deliveryAttempts ?? 0) + 1,
  })

  const outcome = await deliverPrize({
    claimKey: `${machineId}:${claim.txHash}:${unitIndex}`,
    collection: prize.collection,
    tokenId: prize.tokenId,
    player,
    onBroadcast: async (userOpHash) => {
      claim = await advanceClaim(claim, { state: 'sending', userOpHash })
    },
  })
  claim = await applyOutcome(claim, outcome)
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
): Promise<ClaimRecord> {
  if (outcome.kind === 'delivered') {
    return advanceClaim(claim, { state: 'delivered', txDelivered: outcome.txHash })
  }
  if (outcome.kind === 'indeterminate') {
    // The userOp is recorded on the claim; the next resume asks about it.
    return advanceClaim(claim, {
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

/** What a delivery owes besides the artwork. The pledge release runs inline
 *  (see store.settleDeliveredCopy); the rest is deferred. Every leg swallows its
 *  own failure — none of it is the artwork, which is already on-chain. */
async function settle(claim: ClaimRecord, machineId: string): Promise<void> {
  const prize = claim.prize
  if (!prize) return
  await settleDeliveredCopy(machineId, prize).catch(() => {})
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
