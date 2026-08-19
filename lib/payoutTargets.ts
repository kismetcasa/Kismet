import type { Address } from 'viem'
import { ERC20_MINTER_SALE_ABI, FPSS_SALE_ABI } from './saleConfig'
import {
  ZORA_CREATOR_REWARD_RECIPIENT_ABI,
  ZORA_ERC20_MINTER,
  ZORA_FIXED_PRICE_STRATEGY,
} from './zoraMint'

/**
 * The multicall/`useReadContracts` entries that resolve a moment's on-chain
 * payout targets — the TOKEN-level creator-reward recipient plus BOTH sale
 * strategies' `salesConfig.fundsRecipient`. See the header block above
 * `decodePayoutTargets` (lib/distributePlan.ts) for why one pointer is no
 * longer enough; decode the results with that function.
 *
 * Split from the decoder so the decoder stays import-free (unit-verified by
 * scripts/verify-distribute.ts) while the ABI/address wiring lives here, next
 * to the single-source strategy constants.
 *
 * Both strategies are always read: a moment's currency can't be inferred
 * cheaply, an ERC20 moment can still carry a stale FPSS row holding ETH, and
 * an unset row simply decodes to the zero address (dropped).
 */
export const PAYOUT_TARGET_CALLS_PER_MOMENT = 3

export function payoutTargetCalls(collection: Address, tokenId: bigint) {
  return [
    {
      address: collection,
      abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
      functionName: 'getCreatorRewardRecipient' as const,
      args: [tokenId] as const,
    },
    {
      address: ZORA_FIXED_PRICE_STRATEGY,
      abi: FPSS_SALE_ABI,
      functionName: 'sale' as const,
      args: [collection, tokenId] as const,
    },
    {
      address: ZORA_ERC20_MINTER,
      abi: ERC20_MINTER_SALE_ABI,
      functionName: 'sale' as const,
      args: [collection, tokenId] as const,
    },
  ]
}

// 0xSplits' SplitWallet exposes the SplitMain it was cloned against. Probing it
// is an ADDRESS-FREE way to ask "is this contract a 0xSplits wallet?" — no
// SplitMain deployment address to pin per chain, and an EOA or an unrelated
// contract simply reverts/returns nothing. Used to admit splits Kismet has no
// mint-time record of (In Process's moment-manage page can point a moment's
// fundsRecipient at a split after mint).
const SPLIT_WALLET_ABI = [
  {
    name: 'splitMain',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

interface TargetProbeClient {
  getCode: (args: { address: Address }) => Promise<`0x${string}` | undefined>
  readContract: (args: {
    address: Address
    abi: typeof SPLIT_WALLET_ABI
    functionName: 'splitMain'
  }) => Promise<unknown>
}

/** True when `addr` is a contract that answers `splitMain()` — i.e. a 0xSplits
 *  wallet. Any failure (EOA, unrelated contract, RPC hiccup) is false: this
 *  only ever ADMITS targets, so failing closed can't take away coverage that
 *  already exists. */
async function isSplitWallet(client: TargetProbeClient, addr: string): Promise<boolean> {
  try {
    const code = await client.getCode({ address: addr as Address })
    if (!code || code === '0x') return false
    const main = await client.readContract({
      address: addr as Address,
      abi: SPLIT_WALLET_ABI,
      functionName: 'splitMain',
    })
    return typeof main === 'string' && main.toLowerCase() !== ZERO_ADDRESS
  } catch {
    return false
  }
}

/**
 * Narrow a moment's on-chain payout targets to the ones that can actually be
 * distributed.
 *
 * `trustPrimary` says a Kismet mint-time split record exists for this moment.
 * When it does, the PRIMARY target (creator-reward recipient, index 0) passes
 * through untouched — that is the pointer every read here has used since splits
 * shipped, so behaviour on the entire existing corpus is unchanged. Every other
 * case has to earn its place by answering `splitMain()`:
 *
 *   • an ADDITIONAL target (a sale strategy's fundsRecipient) is new here, and
 *     if a moment's sale row still points at the artist's own wallet, admitting
 *     it would surface that wallet's whole balance as "to distribute" and burn
 *     distribute quota on calls that cannot succeed;
 *   • with NO record, the primary is just as likely to be a plain payout wallet
 *     — the Redis record used to be the only thing standing between a
 *     non-split moment and a distribute button over the creator's own balance.
 *
 * Costs nothing in the common case: the two pointers agree on a Kismet split
 * mint, so `targets` has length 1, `trustPrimary` is true, and no probe runs.
 */
export async function filterDistributableTargets(
  client: TargetProbeClient,
  targets: readonly string[],
  opts: { trustPrimary: boolean } = { trustPrimary: true },
): Promise<string[]> {
  if (targets.length === 0) return []
  if (opts.trustPrimary && targets.length === 1) return [...targets]
  const probed = await Promise.all(
    targets.map(async (t, i) =>
      opts.trustPrimary && i === 0 ? t : (await isSplitWallet(client, t)) ? t : null,
    ),
  )
  return probed.filter((t): t is string => t !== null)
}
