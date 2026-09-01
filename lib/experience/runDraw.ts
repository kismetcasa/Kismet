// The draw loop, extracted from the play route with its effects injected.
//
// WHY EXTRACT IT. The loop is where the hardest correctness lives — losing a
// race for the last copy, a grant revoked between freeze and delivery, an
// exhausted pool — and none of that is reachable by a test while it sits inline
// in a route handler that needs Redis and an RPC. With the three effects passed
// in, scripts/verify-experience-flow.ts drives every branch deterministically
// against fakes, and the route becomes a thin caller.
//
// Everything here is synchronous logic over injected async effects; there is no
// I/O of its own and no imports beyond the pure draw core.

import { entryKey, selectByHash, withExcluded } from './draw'
import type { SnapshotEntry } from './types'

export interface DrawEffects {
  /** Atomically consume one copy. Returns the count AFTER decrement — a
   *  negative result means this caller lost a race for the last copy. `null`
   *  means the entry is unlimited and was not decremented.
   *
   *  CONTRACT: consume leaves the counter CORRECT in every case, including a
   *  lost race, where it repairs its own overshoot (see store.consumeOne). A
   *  negative return is a signal to roll forward, never a debt to settle. */
  consume: (key: string) => Promise<number | null>
  /** Hand a copy back after a SUCCESSFUL consume — and only then. */
  release: (key: string) => Promise<void>
  /** Live on-chain authority for one piece: is the grant still held and is the
   *  edition still mintable? */
  authority: (e: SnapshotEntry) => Promise<boolean>
  /** HMAC for this attempt. Injected so the loop stays free of node:crypto and
   *  a test can drive selection deterministically. */
  hash: (attempt: number) => string
}

export type DrawResult =
  | { kind: 'drawn'; prize: SnapshotEntry; attempt: number }
  /** Nothing drawable survived. The caller must PEND the claim — the player has
   *  paid, so this is a solvency breach to surface, never a silent failure. */
  | { kind: 'exhausted'; attempt: number }

/**
 * Draw a prize from a frozen snapshot, rolling forward past entries that cannot
 * actually be delivered.
 *
 * Two distinct reasons to roll forward, and they are NOT symmetric — only one of
 * them owes a copy back:
 *
 *   • LOST RACE — `consume` returned negative, meaning a concurrent play took
 *     the last copy first. No release: the copy was never actually held, and
 *     `consume` has already restored the counter to 0 atomically. Releasing here
 *     too would mint a copy that does not exist, over-issuing past the artist's
 *     consented supply.
 *
 *   • NO AUTHORITY — the artist revoked their grant, the edition minted out, or
 *     the RPC could not answer. Here the consume DID succeed, so the copy is
 *     genuinely held and must be handed back. Fail closed: a redraw costs the
 *     player nothing, while proceeding on an unknown risks a reverted delivery
 *     on a paid play.
 *
 * Each attempt uses its own hash, so a redraw is an independently verifiable
 * draw rather than an opaque re-roll — a player can recompute attempt 0, see it
 * was undeliverable, and recompute attempt 1.
 */
export async function runDraw(
  snapshot: SnapshotEntry[],
  effects: DrawEffects,
  maxAttempts = 6,
): Promise<DrawResult> {
  let working = snapshot
  let attempt = 0

  while (attempt < maxAttempts) {
    const pick = selectByHash(working, effects.hash(attempt))
    if (!pick) return { kind: 'exhausted', attempt }

    const key = entryKey(pick)
    const after = await effects.consume(key)

    if (after !== null && after < 0) {
      // Deliberately no release — see the contract on `consume` above.
      working = withExcluded(working, pick)
      attempt++
      continue
    }

    if (!(await effects.authority(pick))) {
      await effects.release(key)
      working = withExcluded(working, pick)
      attempt++
      continue
    }

    return { kind: 'drawn', prize: pick, attempt }
  }

  // Ran out of attempts rather than out of pool. Treated identically by the
  // caller (the claim pends) because the player's position is the same either
  // way, but the attempt count distinguishes them in the logs.
  return { kind: 'exhausted', attempt }
}
