import { NextRequest, NextResponse, after } from 'next/server'
import type { Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { verifyMintOnChain } from '@/lib/verifyMint'
import { getGateConfig, isPlatformPausedFor } from '@/lib/gate'
import { isBlacklisted } from '@/lib/blacklist'
import { bestEffort } from '@/lib/bestEffort'
import { drawHash, epochFor, snapshotHash } from '@/lib/experience/fairness'
import { runDraw } from '@/lib/experience/runDraw'
import { checkPrizeAuthority } from '@/lib/experience/authority'
import { deliverPrize, reconcileDelivered } from '@/lib/experience/delivery'
import {
  addSpark,
  advanceClaim,
  buildSnapshot,
  consumeOne,
  createClaim,
  getClaim,
  getMachine,
  getPool,
  getRemaining,
  openEpochSeeds,
  recordPlay,
  releaseOne,
  seedForEpoch,
} from '@/lib/experience/store'
import type { ClaimRecord, SnapshotEntry } from '@/lib/experience/types'
import { writeNotification } from '@/lib/notifications'
import { recordCollected } from '@/lib/collected'
import { isMomentHidden } from '@/lib/hiddenMoments'
import { fetchArtworkMeta } from '@/lib/experience/artwork'

/**
 * One play: prove a capsule, claim it exactly once, freeze the pool, draw,
 * verify authority, deliver.
 *
 * The ORDER of the steps below is the security property, not a style choice —
 * each is a gate for the one after it. In particular the snapshot is frozen
 * BEFORE selection, which is the invariant Fake World Assets bought the hard
 * way: its v1 was drained when an attacker changed protocol state between the
 * randomness request and its application. A synchronous draw over a frozen
 * snapshot cannot have that class of bug at all.
 *
 * One unit per request. A multi-quantity capsule mint (N capsules in one
 * transaction) is N calls with distinct `unitIndex` values — each independently
 * claimed, independently random, and independently verifiable. Deriving N draws
 * from one claim would make them un-verifiable individually and, worse, a
 * single-unit assumption would silently swallow N−1 paid plays.
 */

/** Redraw ceiling. A redraw happens only when a live authority check rejects
 *  the drawn piece; more than a few in one play means the pool is broadly
 *  broken, and the claim should pend loudly rather than grind. */
const MAX_ATTEMPTS = 6

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!(await checkRateLimit(`xp-play:${ip}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as {
    machineId?: string
    txHash?: string
    account?: string
    unitIndex?: number
  } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const machineId = typeof body.machineId === 'string' ? body.machineId : ''
  const txHash = body.txHash
  const account = body.account?.toLowerCase()
  const unitIndex = Number.isInteger(body.unitIndex) ? Number(body.unitIndex) : 0

  if (!machineId || !/^[a-z0-9-]{3,64}$/.test(machineId)) return errorResponse(400, 'Invalid machineId')
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return errorResponse(400, 'Invalid txHash')
  if (!account || !isAddress(account)) return errorResponse(400, 'Invalid account')
  if (unitIndex < 0 || unitIndex > 999) return errorResponse(400, 'Invalid unitIndex')

  // 1. Platform pause. Delivery is a gas-sponsored platform write, so it belongs
  //    behind the same kill switch as mint and distribute. Checked FIRST so a
  //    paused platform does not consume a claim it cannot fulfil.
  if (await isPlatformPausedFor(account)) {
    return errorResponse(503, 'Platform is paused')
  }

  const machine = await getMachine(machineId)
  if (!machine) return errorResponse(404, 'Machine not found')
  // `ended` and `delisted` still honour claims. A paid capsule is never
  // stranded by a season closing or a moderation action — those stop SALES.
  if (machine.state === 'draft' || machine.state === 'review') {
    return errorResponse(403, 'Machine is not live')
  }

  // 2. Prove the capsule. Fail-closed on every ambiguity; `units` is the
  //    on-chain quantity, summed across matching logs.
  const proof = await verifyMintOnChain(
    txHash as Hex,
    machine.capsule.collection.toLowerCase(),
    machine.capsule.tokenId,
    account,
  )
  if (!proof.ok) {
    console.warn('[xp] capsule verification failed', { machineId, txHash, account })
    return errorResponse(403, 'Capsule not verified on-chain')
  }
  if (unitIndex >= proof.units) {
    return errorResponse(400, `Capsule covers ${proof.units} play(s); unit ${unitIndex} does not exist`)
  }

  // 3. Claim exactly once. A replay returns the RECORDED outcome rather than
  //    drawing again — the response is identical whether this is the first call
  //    or the fiftieth.
  const now = Date.now()
  const fresh: ClaimRecord = {
    machineId,
    claimant: account,
    txHash: txHash.toLowerCase(),
    unitIndex,
    state: 'claimed',
    createdAt: now,
  }
  const won = await createClaim(fresh).catch(() => {
    // Redis unavailable: fail CLOSED. Refusing costs the player a retry; a draw
    // we cannot record risks delivering twice for one capsule. The capsule stays
    // claimable later — nothing about it is consumed by this refusal.
    return null
  })
  if (won === null) return errorResponse(503, 'Play temporarily unavailable')
  if (!won) {
    const existing = await getClaim(machineId, txHash, unitIndex)
    if (existing) return NextResponse.json({ ok: true, replay: true, units: proof.units, claim: publicClaim(existing) })
    return errorResponse(409, 'Claim in progress')
  }

  let claim = fresh

  // 4. Freeze. Everything from here is a pure function of this snapshot and the
  //    epoch seed — no later pool edit, revocation, or moderation action can
  //    change what this play was drawing from.
  const gate = await getGateConfig()
  const pool = await getPool(machineId)
  const remaining = await getRemaining(machineId)
  const rawSnapshot = buildSnapshot(pool, remaining)

  // Freeze-time exclusions, all fail-closed:
  //  - the Pass collection can NEVER be a prize. lib/pass-validity credits
  //    validity on ANY mint (`if (platform || isMint)`), and our delivery is a
  //    mint, so a Pass artwork in a pool would make this a creator-credential
  //    vending machine. Re-checked here and not only at publish because the
  //    gate's passCollection is a runtime value that can change afterwards.
  //  - hidden artworks must never be dispensed; the hidden sets throw rather
  //    than fail open, and a throw here aborts the freeze rather than silently
  //    widening the pool.
  const passCollection = gate.passCollection?.toLowerCase() ?? null
  const eligibleSnapshot: SnapshotEntry[] = []
  for (const e of rawSnapshot) {
    if (passCollection && e.collection.toLowerCase() === passCollection) continue
    const hidden = await isMomentHidden(e.collection, e.tokenId).catch(() => true)
    if (hidden) continue
    if (await isBlacklisted(e.artist).catch(() => true)) continue
    eligibleSnapshot.push(e)
  }

  const epoch = epochFor(now)
  // openEpochSeeds, not seedForEpoch: it also opens the NEXT epoch, so tomorrow's
  // commitment is public before anyone can transact against it. Idempotent (SET
  // NX), and the read path calls it too, so by the time a play reaches here the
  // seed has almost always been fixed for a full epoch already.
  const { seed } = await seedForEpoch(machineId, epoch)
  const { commitment } = await openEpochSeeds(machineId, epoch)
  const sHash = snapshotHash(eligibleSnapshot)
  claim = await advanceClaim(claim, {
    state: 'frozen',
    snapshot: eligibleSnapshot,
    snapshotHash: sHash,
    epoch,
    commitment,
  })

  // 5–7. Draw, consume, verify authority. The loop itself lives in
  //      lib/experience/runDraw with its effects injected, so every branch —
  //      losing a race for the last copy, a grant revoked mid-play, an exhausted
  //      pool — is reachable by scripts/verify-experience-flow.ts instead of
  //      only in production.
  // Which operator address the grant was actually found on. runDraw returns the
  // instant an authority check passes, so the last value written here belongs to
  // the drawn prize — and delivery must sign as THAT operator or not at all.
  let grantedOperator: string | undefined
  const result = await runDraw(eligibleSnapshot, {
    consume: (key) => consumeOne(machineId, key),
    release: (key) => releaseOne(machineId, key),
    authority: async (e) => {
      const r = await checkPrizeAuthority({ collection: e.collection, tokenId: e.tokenId })
      if (r.ok) grantedOperator = r.operator
      return r.ok
    },
    hash: (attempt) => drawHash({ serverSeed: seed, txHash: claim.txHash, unitIndex, attempt }),
  }, MAX_ATTEMPTS)

  const chosen = result.kind === 'drawn' ? result.prize : null
  const attempt = result.attempt

  if (!chosen) {
    // Pool failure: nothing drawable survived. The claim PENDS visibly rather
    // than failing — the player has paid and is owed an artwork, and this is a
    // solvency breach the machine's own coverage figure should already have been
    // warning about.
    claim = await advanceClaim(claim, {
      state: 'pending',
      attempt,
      pendingReason: 'no eligible artwork available',
    })
    console.error('[xp] pool failure', { machineId, txHash, unitIndex, attempt })
    return NextResponse.json({ ok: true, pending: true, units: proof.units, claim: publicClaim(claim) })
  }

  claim = await advanceClaim(claim, {
    state: 'drawn',
    attempt,
    prize: { collection: chosen.collection, tokenId: chosen.tokenId, artist: chosen.artist },
  })

  // 8. Deliver. The userOpHash is persisted the instant it exists — BEFORE the
  //    wait — so an indeterminate timeout is reconcilable instead of a mystery.
  const outcome = await deliverPrize({
    collection: chosen.collection,
    tokenId: chosen.tokenId,
    player: account,
    operator: grantedOperator,
    onBroadcast: async (userOpHash) => {
      claim = await advanceClaim(claim, { state: 'sending', userOpHash })
    },
  })

  if (outcome.kind === 'delivered') {
    claim = await advanceClaim(claim, { state: 'delivered', txDelivered: outcome.txHash })
  } else if (outcome.kind === 'indeterminate') {
    // NEVER retry here. Ask the chain instead.
    const landed = await reconcileDelivered({
      collection: chosen.collection,
      tokenId: chosen.tokenId,
      player: account,
    })
    claim =
      landed === true
        ? await advanceClaim(claim, { state: 'delivered' })
        : await advanceClaim(claim, {
            state: 'pending',
            pendingReason: 'delivery submitted but unconfirmed — reconciling',
          })
  } else {
    claim = await advanceClaim(claim, {
      state: 'pending',
      pendingReason:
        outcome.kind === 'unsponsored'
          ? 'delivery could not be sponsored'
          : outcome.kind === 'reverted'
            ? 'delivery reverted on-chain'
            : 'delivery unavailable',
    })
    console.error('[xp] delivery failed', { machineId, txHash, unitIndex, outcome })
  }

  // 9. Record. Non-critical: a failure here costs an index entry, never the art.
  const prize = chosen
  after(async () => {
    await Promise.all([
      recordPlay(machineId, account, claim.txHash).catch(() => {}),
      addSpark(machineId, account, 1).catch(() => {}),
      claim.state === 'delivered'
        ? recordCollected(account, prize.collection, prize.tokenId).catch(() => {})
        : Promise.resolve(),
    ])
    if (claim.state === 'delivered') {
      // Hydrate the title and cover so the notification (and the Farcaster push
      // built from it) names the artwork rather than saying "an artwork". Best
      // effort by construction: fetchArtworkMeta returns null on any failure and
      // both fields are optional, so a metadata outage costs the notification its
      // picture, never its delivery.
      const meta = await fetchArtworkMeta(prize.collection, prize.tokenId)
      await writeNotification({
        type: 'experience_win',
        recipient: account,
        actor: prize.artist,
        tokenAddress: prize.collection,
        tokenId: prize.tokenId,
        tokenName: meta?.name ?? undefined,
        tokenImage: meta?.image ?? undefined,
        amount: 1,
      }).catch(bestEffort('xp.notifyWin', { machineId, txHash }))
    }
  })

  // `units` is the proved on-chain quantity for the WHOLE transaction — the
  // client uses it to open the remaining units of a capsule it did not mint
  // itself (a pasted or discovered hash arrives with no local unit count).
  return NextResponse.json({ ok: true, units: proof.units, claim: publicClaim(claim) })
}

/** The claim as a player may see it. The snapshot and its hash are public — they
 *  are the receipt — but nothing here exposes the epoch seed, which stays secret
 *  until its epoch closes. */
function publicClaim(c: ClaimRecord) {
  return {
    state: c.state,
    prize: c.prize ?? null,
    attempt: c.attempt ?? 0,
    epoch: c.epoch ?? null,
    snapshotHash: c.snapshotHash ?? null,
    unitIndex: c.unitIndex,
    pendingReason: c.pendingReason ?? null,
    txDelivered: c.txDelivered ?? null,
  }
}
