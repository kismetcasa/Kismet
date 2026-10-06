import 'server-only'
import { serverBaseClient } from '@/lib/rpc'

/**
 * The block that seals a draw.
 *
 * A draw is HMAC(seed, tx:unit:attempt:blockHash) (fairnessCore.drawMessage).
 * The block is the first one after the claim is frozen: its NUMBER is written
 * into the claim with the seed and the table, before the block exists, and
 * the draw waits for it. So at the moment everything the draw depends on is
 * fixed, its outcome is still unknown to everyone — Kismet, which holds the
 * seed, included — and since the block always comes after the capsule's own,
 * the player could not have shaped their transaction to it either.
 *
 * It also removes the one case where a seed's timing mattered: a seed nobody
 * opened in advance is created at the play, after the player's transaction —
 * but still before the sealing block, so it cannot have been picked to suit
 * the outcome.
 *
 * Base makes a block every two seconds, so the wait is about one second on
 * average and at most a couple.
 */

/** How long a draw waits for its block before the claim pends (resume
 *  finishes it from the same freeze). Three Base blocks. */
const WAIT_MS = 6_000
const POLL_MS = 400

/** The chain's current height, read fresh; null when it cannot be read. */
export async function chainHead(): Promise<number | null> {
  try {
    return Number(await serverBaseClient().getBlockNumber({ cacheTime: 0 }))
  } catch {
    return null
  }
}

/** The hash of block `n`, waiting for it to be made; null if it is not made
 *  (or cannot be read) in time. */
export async function awaitBlockHash(n: number, waitMs = WAIT_MS): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const block = await serverBaseClient().getBlock({ blockNumber: BigInt(n) })
      if (block?.hash) return block.hash.toLowerCase()
    } catch {
      // Not made yet, or the read failed: ask again until the deadline.
    }
    if (Date.now() + POLL_MS > deadline) return null
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}
