import type { Address, ContractFunctionParameters } from 'viem'
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

export function payoutTargetCalls(
  collection: Address,
  tokenId: bigint,
): ContractFunctionParameters[] {
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
