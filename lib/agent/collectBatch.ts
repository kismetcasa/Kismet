import { encodeFunctionData, toHex, type Address } from 'viem'
import {
  ERC20_ABI,
  USDC_BASE,
  ZORA_ERC20_MINTER,
  buildEthMintCall,
  buildUsdcMintCall,
} from '@/lib/zoraMint'
import { withBuilderSuffix } from './calldata'
import type { AgentCall } from './types'

/**
 * Pure builder for a multi-collect ("collect these N") EIP-5792 batch — one
 * Base MCP `send_calls` approval for a whole basket. This is the execution
 * primitive behind both Co-pilot's batch collect and a Scout's Propose mode.
 *
 * Correctness that a naive per-item concat gets WRONG, and we get right:
 *   - USDC: ERC20.approve SETS (not increments) the allowance, and each mint
 *     pulls via transferFrom. So N per-item approves would clobber each other
 *     and later mints would revert. We emit a SINGLE approve to the ERC20Minter
 *     for the SUMMED USDC cost (only if the current allowance is short), then
 *     all USDC mints.
 *   - ETH: each mint carries its own value; the batch's native value is the sum
 *     (each call keeps its own value; send_calls totals them).
 *
 * Network-free: per-item price/currency/mintFee and the current allowance are
 * injected (resolved upstream), so this is unit-verifiable. `account` is the
 * SENDER (pays USDC/value, holds the approve); `recipient` is mintTo (the NFT
 * receiver) and defaults to `account`. They differ for the Scout, where the
 * sub-account sends/pays but the user's universal account receives. Builder
 * suffix + Zora referral are preserved by the shared builders.
 */
export interface BatchCollectItem {
  collection: Address
  tokenId: bigint
  quantity: bigint
  currency: 'eth' | 'usdc'
  pricePerToken: bigint
  /** Protocol mint fee (wei). ETH items only; ignored for USDC. */
  mintFee: bigint
  comment: string
}

export interface BatchCollectPlan {
  calls: AgentCall[]
  /** Native value the user spends across the batch (wei). */
  totalNativeValue: bigint
  /** USDC cost across the batch (6dp base units). */
  totalUsdcCost: bigint
  /** True when a single summed USDC approve was prepended. */
  usdcApproveIncluded: boolean
}

export function buildCollectBatchPlan(params: {
  /** Sender: pays USDC/value and holds the ERC20Minter approve (msg.sender). */
  account: Address
  /** NFT recipient (mintTo). Defaults to `account`. */
  recipient?: Address
  items: readonly BatchCollectItem[]
  /** Current account → ERC20Minter USDC allowance. */
  usdcAllowance: bigint
}): BatchCollectPlan {
  const { account, items, usdcAllowance } = params
  const recipient = params.recipient ?? account

  const usdcMintCalls: AgentCall[] = []
  const ethMintCalls: AgentCall[] = []
  let totalNativeValue = 0n
  let totalUsdcCost = 0n

  for (const it of items) {
    if (it.currency === 'eth') {
      const m = buildEthMintCall({
        tokenId: it.tokenId,
        mintTo: recipient,
        quantity: it.quantity,
        mintFee: it.mintFee,
        pricePerToken: it.pricePerToken,
        comment: it.comment,
      })
      ethMintCalls.push({
        to: it.collection,
        data: withBuilderSuffix(encodeFunctionData({ abi: m.abi, functionName: m.functionName, args: m.args })),
        value: toHex(m.value),
      })
      totalNativeValue += m.value
    } else {
      totalUsdcCost += it.pricePerToken * it.quantity
      const m = buildUsdcMintCall({
        collection: it.collection,
        tokenId: it.tokenId,
        mintTo: recipient,
        quantity: it.quantity,
        pricePerToken: it.pricePerToken,
        comment: it.comment,
      })
      usdcMintCalls.push({
        to: ZORA_ERC20_MINTER,
        data: withBuilderSuffix(encodeFunctionData({ abi: m.abi, functionName: m.functionName, args: m.args })),
        value: '0x0',
      })
    }
  }

  const calls: AgentCall[] = []
  let usdcApproveIncluded = false
  if (totalUsdcCost > 0n && usdcAllowance < totalUsdcCost) {
    calls.push({
      to: USDC_BASE,
      data: withBuilderSuffix(encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ZORA_ERC20_MINTER, totalUsdcCost] })),
      value: '0x0',
    })
    usdcApproveIncluded = true
  }
  // Approve first, then all mints (USDC then ETH — order among mints is moot).
  calls.push(...usdcMintCalls, ...ethMintCalls)

  return { calls, totalNativeValue, totalUsdcCost, usdcApproveIncluded }
}
