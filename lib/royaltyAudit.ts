import { serverBaseClient } from './rpc'
import { redis } from './redis'
import { isAddress } from './address'
import type { RoyaltyCreditOutcome } from './stats'

// ── Royalty-receiver audit (instrumentation) ─────────────────────────────────
//
// Secondary-sale royalties pay the collection-wide EIP-2981 receiver. A WALLET
// receiver itemizes on the artist's earnings card directly; a CONTRACT
// receiver (a 0xSplits split) is decomposed into per-member credits by
// creditListingRoyalty when the receiver matches the token's creator-reward
// recipient AND we hold the split's stored recipient list — otherwise the
// whole amount falls back onto the contract address, where no artist's card
// can read it.
//
// This records each fill so the decomposition's real-world coverage rests on
// data, not guesses: how often royalties pay wallets vs contracts, and how
// often a contract receiver actually decomposed. It records the CREDIT PATH'S
// OWN OUTCOME (RoyaltyCreditOutcome, returned by creditListingRoyalty) rather
// than re-deriving the receiver↔split match with its own reads — an earlier
// version recomputed the match independently, which double-paid the RPC/Redis
// reads on every fill and could drift from what the credit actually did,
// making the instrumentation lie about the mechanism it exists to measure.
// Best-effort, off the response path — never affects the sale.
//
// Readout (inspect after some secondary sales have happened):
//   GET    kismetart:royalty-audit:wallet      — count of wallet-receiver fills
//   GET    kismetart:royalty-audit:contract    — count of contract-receiver fills
//   LRANGE kismetart:royalty-split-audit 0 -1  — recent contract-receiver detail
//                                                 (credit outcome per fill),
//                                                 newest first
const WALLET_COUNT_KEY = 'kismetart:royalty-audit:wallet'
const CONTRACT_COUNT_KEY = 'kismetart:royalty-audit:contract'
const DETAIL_KEY = 'kismetart:royalty-split-audit'
const MAX_DETAIL = 500

export async function auditRoyaltyReceiver(args: {
  listingId: string
  collection: string
  tokenId: string
  receiver: string
  currency: 'eth' | 'usdc'
  amount: number
  /** What creditListingRoyalty actually did for this fill. */
  outcome: RoyaltyCreditOutcome
}): Promise<void> {
  const { listingId, collection, tokenId, receiver, currency, amount, outcome } = args
  try {
    const lower = receiver.toLowerCase()
    if (!isAddress(lower)) return
    const code = await serverBaseClient().getCode({ address: lower as `0x${string}` })
    const isContract = !!code && code !== '0x'
    if (!isContract) {
      // Wallet receiver — itemizes directly; just count it for the ratio.
      await redis.incr(WALLET_COUNT_KEY)
      return
    }
    // Contract receiver — record whether the credit path decomposed it, which
    // candidate token's split matched, and whether the credit landed. A fill
    // with decomposed:false here is a royalty stranded on a contract address
    // (unstored split, receiver↔split mismatch, or a bounded read that timed
    // out) — the number to watch when judging remaining coverage gaps.
    const entry = JSON.stringify({
      at: Date.now(),
      listingId,
      collection: collection.toLowerCase(),
      tokenId,
      receiver: lower,
      currency,
      amount,
      credited: outcome.credited,
      decomposed: outcome.decomposed,
      matchedTokenId: outcome.matchedTokenId,
      creditCount: outcome.credits.length,
    })
    await Promise.all([redis.incr(CONTRACT_COUNT_KEY), redis.lpush(DETAIL_KEY, entry)])
    await redis.ltrim(DETAIL_KEY, 0, MAX_DETAIL - 1)
  } catch {
    // Pure observability — never throw, never affect the sale.
  }
}
