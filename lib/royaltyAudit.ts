import { serverBaseClient } from './rpc'
import { redis } from './redis'
import { isAddress } from './address'
import { getStoredSplits } from './splits'
import { ZORA_CREATOR_REWARD_RECIPIENT_ABI } from './zoraMint'

// ── Royalty-receiver audit (instrumentation) ─────────────────────────────────
//
// Secondary-sale royalties pay the collection-wide EIP-2981 receiver. A WALLET
// receiver already itemizes on the artist's earnings card (creditListingRoyalty
// credits it; getArtistEarnings unions it across siblings). A CONTRACT receiver —
// a 0xSplits split — does NOT: 0xSplits stores members as a hash (unreadable
// on-chain), and Kismet only records PRIMARY-payout split membership, never
// royalty splits. So a split-royalty can't be itemized per-artist today.
//
// This records each royalty fill so the decision to build a resolver rests on
// real data, not a guess about frequency. It also runs the resolver's
// PRECONDITION test: the only royalty split we could ever resolve is one that
// coincides with a Kismet payout split whose members we stored. So for contract
// receivers it records whether the receiver matches the listed/cover token split
// AND whether we actually hold that split's recipients (`resolvable`). Best-
// effort, off the response path — never affects the sale.
//
// Readout (inspect after some secondary sales have happened):
//   GET    kismetart:royalty-audit:wallet      — count of wallet-receiver fills
//   GET    kismetart:royalty-audit:contract    — count of contract-receiver fills
//   LRANGE kismetart:royalty-split-audit 0 -1  — recent contract-receiver detail,
//                                                 with match flags, newest first
const WALLET_COUNT_KEY = 'kismetart:royalty-audit:wallet'
const CONTRACT_COUNT_KEY = 'kismetart:royalty-audit:contract'
const DETAIL_KEY = 'kismetart:royalty-split-audit'
const MAX_DETAIL = 500

// The on-chain creator-reward recipient for a token — the 0xSplits address when
// the moment has a split, else the payout wallet. null when the read reverts
// (collection predates the interface, RPC blip). Used only to classify the audit.
async function creatorRewardRecipient(collection: string, tokenId: string): Promise<string | null> {
  try {
    const r = await serverBaseClient().readContract({
      address: collection as `0x${string}`,
      abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
      functionName: 'getCreatorRewardRecipient',
      args: [BigInt(tokenId)],
    })
    return String(r).toLowerCase()
  } catch {
    return null
  }
}

export async function auditRoyaltyReceiver(args: {
  listingId: string
  collection: string
  tokenId: string
  receiver: string
  currency: 'eth' | 'usdc'
  amount: number
}): Promise<void> {
  const { listingId, collection, tokenId, receiver, currency, amount } = args
  try {
    const lower = receiver.toLowerCase()
    if (!isAddress(lower)) return
    const code = await serverBaseClient().getCode({ address: lower as `0x${string}` })
    const isContract = !!code && code !== '0x'
    if (!isContract) {
      // Wallet receiver — already itemizes; just count it for the ratio.
      await redis.incr(WALLET_COUNT_KEY)
      return
    }
    // Contract receiver — flag whether it's a Kismet payout split (the listed
    // token's, or the cover token #1's). An address match alone isn't enough to
    // resolve it: a token minted outside Kismet's flow can match on-chain yet have
    // no stored members. So `resolvable` is the real precondition for a future
    // resolver — the split matches AND we actually hold its recipient list.
    const [tokenSplit, coverSplit] = await Promise.all([
      creatorRewardRecipient(collection, tokenId),
      creatorRewardRecipient(collection, '1'),
    ])
    const matchesTokenSplit = !!tokenSplit && tokenSplit === lower
    const matchesCoverSplit = !!coverSplit && coverSplit === lower
    const [tokenStored, coverStored] = await Promise.all([
      matchesTokenSplit ? getStoredSplits(collection, tokenId) : Promise.resolve(null),
      matchesCoverSplit ? getStoredSplits(collection, '1') : Promise.resolve(null),
    ])
    const resolvable =
      (tokenStored?.recipients.length ?? 0) > 0 || (coverStored?.recipients.length ?? 0) > 0
    const entry = JSON.stringify({
      at: Date.now(),
      listingId,
      collection: collection.toLowerCase(),
      tokenId,
      receiver: lower,
      currency,
      amount,
      matchesTokenSplit,
      matchesCoverSplit,
      resolvable,
    })
    await Promise.all([redis.incr(CONTRACT_COUNT_KEY), redis.lpush(DETAIL_KEY, entry)])
    await redis.ltrim(DETAIL_KEY, 0, MAX_DETAIL - 1)
  } catch {
    // Pure observability — never throw, never affect the sale.
  }
}
