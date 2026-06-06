import { encodeFunctionData, type Hex } from 'viem'
import { SEAPORT_ADDRESS, SEAPORT_ABI, deserializeOrder } from '@/lib/seaport'
import { ERC20_ABI, USDC_BASE } from '@/lib/zoraMint'
import type { Listing } from '@/lib/listings'
import { withBuilderSuffix } from './calldata'
import type { AgentCall } from './types'

/**
 * Pure builder for a "buy" (Seaport fulfill) EIP-5792 call batch — the exact
 * calldata the web app's BuyButton produces, assembled for Base MCP's
 * send_calls. Network-free: the only on-chain-read value (USDC allowance) is
 * injected so this is unit-verifiable without a chain.
 *
 * ETH listing  → one call: Seaport.fulfillOrder(order, 0) with value = price.
 * USDC listing → optional USDC.approve(Seaport, price) then fulfillOrder(...),
 *                the approve batched into the SAME single user approval.
 *
 * The stored order was already shape- + signature- + royalty-validated by
 * /api/listings at creation time, so we trust it and just rebuild the
 * fulfillment exactly as BuyButton does (note: OrderParameters drops `counter`
 * and adds totalOriginalConsiderationItems).
 */
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const

export interface BuyPlan {
  calls: AgentCall[]
  /** Native value the buyer spends (wei). USDC path is 0 (paid via allowance). */
  totalValue: bigint
  /** Price in the listing currency's base units. */
  price: bigint
  currency: 'eth' | 'usdc'
  /** True when a USDC approve was prepended to the batch. */
  approvalIncluded: boolean
}

export function buildBuyPlan(input: { listing: Listing; seaportUsdcAllowance: bigint }): BuyPlan {
  const { listing, seaportUsdcAllowance } = input
  const order = deserializeOrder(listing.orderComponents)
  const price = BigInt(listing.price)
  const currency: 'eth' | 'usdc' = listing.currency ?? 'eth'

  const fulfillData = withBuilderSuffix(
    encodeFunctionData({
      abi: SEAPORT_ABI,
      functionName: 'fulfillOrder',
      args: [
        {
          parameters: {
            offerer: order.offerer,
            zone: order.zone,
            offer: order.offer,
            consideration: order.consideration,
            orderType: order.orderType,
            startTime: order.startTime,
            endTime: order.endTime,
            zoneHash: order.zoneHash,
            salt: order.salt,
            conduitKey: order.conduitKey,
            // OrderParameters carries the consideration count, not the signing
            // `counter`. Matches BuyButton exactly.
            totalOriginalConsiderationItems: BigInt(order.consideration.length),
          },
          signature: listing.signature as Hex,
        },
        ZERO_BYTES32,
      ],
    }),
  )

  if (currency === 'usdc') {
    const calls: AgentCall[] = []
    let approvalIncluded = false
    if (seaportUsdcAllowance < price) {
      const approveData = withBuilderSuffix(
        encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [SEAPORT_ADDRESS, price] }),
      )
      calls.push({ to: USDC_BASE, data: approveData, value: '0' })
      approvalIncluded = true
    }
    calls.push({ to: SEAPORT_ADDRESS, data: fulfillData, value: '0' })
    return { calls, totalValue: 0n, price, currency, approvalIncluded }
  }

  return {
    calls: [{ to: SEAPORT_ADDRESS, data: fulfillData, value: price.toString() }],
    totalValue: price,
    price,
    currency,
    approvalIncluded: false,
  }
}
