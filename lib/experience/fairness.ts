// Commit–reveal receipts for the capsule draw. Uses node:crypto's synchronous
// HMAC/hash rather than Web Crypto's async subtle API: the draw runs inside a
// single request on a paid action, and an await per hash buys nothing here (the
// route is already Node runtime — see /api/raffle/manage, which imports
// node:crypto for the same reason).
//
// WHY THIS EXISTS AT ALL. For platform-run seasons, "the server drew with
// crypto-grade randomness" matches the trust model the raffle already ships and
// users accept. The moment OTHER PEOPLE's machines run on our RNG, we become an
// arbiter rather than a participant, and an arbiter should carry receipts.
//
// WHAT IT PROVES, AND THE HOLE IT CLOSES. The industry-standard scheme
// (serverSeed committed in advance, client entropy, reveal on rotation) proves
// only that an outcome was derived from the committed seed. It proves NOTHING
// about whether the odds table the seed indexed into is the one that was
// published — operators have shipped "provably fair" over rigged tables on
// exactly that gap. So we commit the WEIGHT TABLE too: `snapshotHash` is
// published alongside the seed commitment, which makes the receipt and the
// disclosure the same object. Without it, a weight could change between rounds
// and every individual verification would still pass.
//
// THE CLIENT ENTROPY IS THE PLAYER'S TRANSACTION HASH. It cannot exist before
// the epoch's commitment is published (the capsule mint happens later), and the
// player alone caused it, so it satisfies the "client seed must be genuinely
// the player's" requirement without asking them to manage a seed.

import { createHash, createHmac } from 'node:crypto'
import type { SnapshotEntry } from './types'
import { canonicalSnapshot, drawMessage, epochFor, nextEpoch } from './fairnessCore'

export { canonicalSnapshot, drawMessage, epochFor, nextEpoch }

/** Commitment published in advance for an epoch: sha256 of the server seed.
 *  Revealing the seed later lets anyone recompute every draw bound to it. */
export function commitmentFor(serverSeed: string): string {
  return createHash('sha256').update(serverSeed, 'utf8').digest('hex')
}

export function snapshotHash(snapshot: SnapshotEntry[]): string {
  return createHash('sha256').update(canonicalSnapshot(snapshot), 'utf8').digest('hex')
}

/**
 * The draw hash: HMAC-SHA256 over the committed seed, keyed to this exact play
 * (fairnessCore.drawMessage).
 *
 * `attempt` makes a redraw independently verifiable rather than opaque. A
 * redraw happens when the live authority re-check fails (grant revoked, edition
 * minted out, artwork hidden between freeze and delivery); binding the attempt
 * number into the message means each attempt is its own checkable draw, instead
 * of the server appearing to "re-roll until it liked the answer".
 *
 * `blockHash` seals the draw with a block that did not exist when the seed and
 * the table were fixed; a claim drawn before it existed has none.
 */
export function drawHash(params: {
  serverSeed: string
  txHash: string
  unitIndex: number
  attempt: number
  blockHash?: string | null
}): string {
  return createHmac('sha256', params.serverSeed).update(drawMessage(params), 'utf8').digest('hex')
}

/**
 * Recompute a published draw from revealed material. This is the verifier's
 * entire job, and it deliberately checks BOTH halves:
 *   1. the revealed seed matches the commitment that was published in advance;
 *   2. the snapshot matches the hash committed at freeze.
 * Only then is the outcome recomputed. A caller that skipped (2) would be
 * running the very check that "provably fair" implementations are criticised
 * for omitting.
 */
export function verifyDraw(params: {
  serverSeed: string
  commitment: string
  snapshot: SnapshotEntry[]
  snapshotHash: string
  txHash: string
  unitIndex: number
  attempt: number
  blockHash?: string | null
}): { ok: boolean; reason?: string; hash?: string } {
  if (commitmentFor(params.serverSeed) !== params.commitment) {
    return { ok: false, reason: 'seed does not match the published commitment' }
  }
  if (snapshotHash(params.snapshot) !== params.snapshotHash) {
    return { ok: false, reason: 'snapshot does not match the committed weight table' }
  }
  return {
    ok: true,
    hash: drawHash({
      serverSeed: params.serverSeed,
      txHash: params.txHash,
      unitIndex: params.unitIndex,
      attempt: params.attempt,
      blockHash: params.blockHash,
    }),
  }
}


