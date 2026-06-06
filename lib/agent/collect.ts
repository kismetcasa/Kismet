import { encodeFunctionData, type Address } from 'viem'
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
 * Pure builder for a "collect" (primary mint) EIP-5792 call batch — the exact
 * calldata the web app's useDirectCollect produces, assembled for Base MCP's
 * send_calls. Network-free by design: every on-chain-read value (price,
 * mintFee, allowance) is injected so this is unit-verifiable without a chain.
 * The route in app/api/agent/prepare-collect does the reads and calls this.
 *
 * ETH path  → one call: collection.mint(...) with value = (mintFee+price)*qty.
 * USDC path → optional USDC.approve(ERC20Minter, total) then ERC20Minter.mint(...).
 *             The approve is only included when the current allowance is short,
 *             and Base MCP batches it into the SAME single user approval.
 *
 * Treasury/attribution invariants come for free: buildEthMintCall /
 * buildUsdcMintCall pin KISMET_REFERRAL + the strategy address, and
 * withBuilderSuffix carries the ERC-8021 builder code.
 */
export interface CollectPlanInput {
  collection: Address
  tokenId: bigint
  /** Recipient + payer: the user's Base Account smart-wallet address. */
  account: Address
  quantity: bigint
  currency: 'eth' | 'usdc'
  /** On-chain sale price per token, base units (wei for ETH, 6dp for USDC). */
  pricePerToken: bigint
  comment: string
  /** ETH path only: protocol mint fee (wei) from readMintFeeWithBound. */
  mintFee: bigint
  /** USDC path only: current allowance of account → ERC20Minter. */
  usdcAllowance: bigint
}

export interface CollectPlan {
  calls: AgentCall[]
  /** Native value the user spends (wei). USDC path is 0 (paid via allowance). */
  totalValue: bigint
  /** Token cost in the sale currency's base units (price × qty). */
  totalCost: bigint
  /** True when a one-time USDC approve was prepended to the batch. */
  approvalIncluded: boolean
}

export function buildCollectPlan(input: CollectPlanInput): CollectPlan {
  const { collection, tokenId, account, quantity, currency, pricePerToken, comment, mintFee, usdcAllowance } = input
  const totalCost = pricePerToken * quantity

  if (currency === 'eth') {
    const mint = buildEthMintCall({ tokenId, mintTo: account, quantity, mintFee, pricePerToken, comment })
    const data = withBuilderSuffix(
      encodeFunctionData({ abi: mint.abi, functionName: mint.functionName, args: mint.args }),
    )
    return {
      calls: [{ to: collection, data, value: mint.value.toString() }],
      totalValue: mint.value,
      totalCost,
      approvalIncluded: false,
    }
  }

  // USDC: the ERC20Minter pulls funds via transferFrom, so an allowance must
  // cover the cost first. Mirror useDirectCollect: approve the exact total
  // (bounded, not max) only when short.
  const calls: AgentCall[] = []
  let approvalIncluded = false
  if (usdcAllowance < totalCost) {
    const approveData = withBuilderSuffix(
      encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ZORA_ERC20_MINTER, totalCost] }),
    )
    calls.push({ to: USDC_BASE, data: approveData, value: '0' })
    approvalIncluded = true
  }
  const mint = buildUsdcMintCall({ collection, tokenId, mintTo: account, quantity, pricePerToken, comment })
  const mintData = withBuilderSuffix(
    encodeFunctionData({ abi: mint.abi, functionName: mint.functionName, args: mint.args }),
  )
  calls.push({ to: ZORA_ERC20_MINTER, data: mintData, value: '0' })

  return { calls, totalValue: 0n, totalCost, approvalIncluded }
}
