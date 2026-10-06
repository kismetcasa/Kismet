// The parts of the commit–reveal scheme that are text, not crypto: what gets
// hashed, in what form. PURE — no node:crypto, no Web Crypto — so the server
// (lib/experience/fairness, node:crypto) and the player's browser
// (lib/experience/fairnessWeb, Web Crypto) hash the very same strings, and a
// draw recomputed on the verify page cannot drift from the one that was made.

import type { SnapshotEntry } from './types'

/**
 * Canonical serialization of a frozen snapshot. Field order and formatting are
 * fixed here so the same snapshot always produces the same digest across
 * processes, deploys and browsers — a verifier recomputing it from the
 * published snapshot must land on the identical string.
 *
 * `remaining` is included: two draws over the same pieces but different
 * remaining counts are genuinely different distributions, and a verifier must
 * be able to tell them apart.
 */
export function canonicalSnapshot(snapshot: SnapshotEntry[]): string {
  return snapshot
    .map((e) =>
      [
        e.collection.toLowerCase(),
        e.tokenId,
        e.artist.toLowerCase(),
        String(e.weight),
        e.remaining === null ? 'open' : String(e.remaining),
      ].join('|'),
    )
    .join('\n')
}

/**
 * The message the seed is HMAC'd over for one attempt of one play.
 *
 * `blockHash` is the hash of the block that seals the draw: the first Base
 * block after the claim was frozen, its number fixed before the block existed
 * (see ClaimRecord.entropy). Mixing it in means that when the seed and the
 * table were fixed, the outcome was still unknown to everyone — Kismet, which
 * holds the seed, included — and a seed committed late cannot be chosen to
 * suit a transaction already on chain. Claims drawn before it existed have no
 * block, and keep the message they were drawn under.
 */
export function drawMessage(params: { txHash: string; unitIndex: number; attempt: number; blockHash?: string | null }): string {
  const base = `${params.txHash.toLowerCase()}:${params.unitIndex}:${params.attempt}`
  return params.blockHash ? `${base}:${params.blockHash.toLowerCase()}` : base
}

/** Epoch label for a timestamp — the rotation unit for server seeds.
 *
 *  Derived from UTC calendar day. The claim record stores the epoch it was
 *  frozen under, so a play spanning a rotation boundary verifies against the
 *  epoch that was live when it was frozen rather than against "today" (edge
 *  case C12/C13 in the spec). */
export function epochFor(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The epoch after this one.
 *
 *  Exists so a seed can be COMMITTED AHEAD, published a day before it draws.
 *  (Since draws mix in a block after the freeze, a seed's timing no longer
 *  decides whether its outcome could be foreseen; committing ahead still means
 *  a published commitment is what every play is held to.)
 *
 *  String arithmetic on the UTC date, via Date.UTC, so month and year rollovers
 *  and leap days are the platform's problem rather than ours. */
export function nextEpoch(epoch: string): string {
  const [y, m, d] = epoch.split('-').map(Number)
  return epochFor(Date.UTC(y, m - 1, d + 1))
}
