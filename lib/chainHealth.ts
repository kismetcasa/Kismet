import type { PublicClient } from 'viem'

// Base targets ~2s block times, so across a 4s sample a healthy chain advances
// at least one block. Zero forward progress means the sequencer has stalled
// (the Jun 2026 "invalid block sequenced" consensus halt after block 47806542
// is the canonical case). Kept short so it only briefly delays an
// already-failed deploy's error toast.
const SAMPLE_MS = 4000

/**
 * True if Base block production appears STALLED — the chain head did not
 * advance across a short sampling window.
 *
 * Why two reads: during a stall, `getBlockNumber` keeps returning the LAST
 * produced block successfully (reads work; it's writes that fail), so a single
 * read can never detect a halt — only the absence of forward progress can.
 * `/api/readiness`'s one-shot `getBlockNumber` looks healthy through a stall for
 * exactly this reason.
 *
 * Fail-OPEN (returns false) on any read error so a flaky or rate-limited RPC
 * never masquerades as a chain stall and mislabels an ordinary transient.
 * `cacheTime: 0` forces both reads past viem's block-number cache, otherwise the
 * second call could echo the first and report a false stall.
 */
export async function isChainStalled(
  client: PublicClient,
  sampleMs: number = SAMPLE_MS,
): Promise<boolean> {
  try {
    const first = await client.getBlockNumber({ cacheTime: 0 })
    await new Promise((resolve) => setTimeout(resolve, sampleMs))
    const second = await client.getBlockNumber({ cacheTime: 0 })
    return second <= first
  } catch {
    return false
  }
}
