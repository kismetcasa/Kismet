import { encodeFunctionData, parseEther, parseUnits, type Address } from 'viem'
import {
  SEAPORT_ADDRESS,
  SEAPORT_DOMAIN,
  SEAPORT_ORDER_TYPES,
  ERC1155_ABI,
  buildSellOrder,
  serializeOrder,
  type SerializedOrderComponents,
} from '@/lib/seaport'
import { computePlatformFee, PLATFORM_FEE_RECIPIENT } from '@/lib/platformFee'
import { withBuilderSuffix } from './calldata'
import type { AgentCall } from './types'

/**
 * Pure builder for a "list" (Seaport offer) — the exact artifacts the web app's
 * ListButton produces, assembled for Base MCP. Network-free: every on-chain
 * read (royalty, Seaport counter, approval state) is injected so this is
 * unit-verifiable without a chain.
 *
 * Listing is signature-based: no funds move. The agent (1) optionally runs the
 * one-time setApprovalForAll via send_calls, (2) signs the returned EIP-712
 * typed data via Base MCP `sign`, then (3) POSTs the order to /api/listings —
 * which independently re-validates shape, signature (ERC-1271-aware), and full
 * EIP-2981 royalty. buildSellOrder fixes a 30-day expiry, matching the web app.
 */
export interface ListPlanInput {
  collection: Address
  tokenId: string
  seller: Address
  currency: 'eth' | 'usdc'
  /** Human price like "0.01" (ETH) or "5" (USDC). */
  price: string
  royaltyReceiver: Address
  royaltyAmount: bigint
  counter: bigint
  isApprovedForAll: boolean
  name?: string
  image?: string
  creatorAddress?: string
}

export interface ListPlan {
  /** send_calls batch for the one-time setApprovalForAll, or undefined. */
  calls?: AgentCall[]
  /** EIP-712 typed data to sign (JSON-safe: uint fields are decimal strings,
   *  which wallets/viem coerce to bigint at sign time). */
  typedData: {
    domain: typeof SEAPORT_DOMAIN
    types: typeof SEAPORT_ORDER_TYPES
    primaryType: 'OrderComponents'
    message: SerializedOrderComponents
  }
  /** Body to POST to /api/listings; the agent fills in `signature`. */
  listingPostBody: Record<string, unknown>
  priceTotal: bigint
  sellerProceeds: bigint
  needsApproval: boolean
}

/** Convert a human price string to the currency's base units (wei / 6dp USDC). */
export function priceToBaseUnits(price: string, currency: 'eth' | 'usdc'): bigint {
  return currency === 'usdc' ? parseUnits(price, 6) : parseEther(price)
}

export function buildListPlan(input: ListPlanInput): ListPlan {
  const { collection, tokenId, seller, currency, price, royaltyReceiver, royaltyAmount, counter, isApprovedForAll } = input
  const priceTotal = priceToBaseUnits(price, currency)
  const platformFee = computePlatformFee(priceTotal)
  const sellerProceeds = priceTotal - royaltyAmount - platformFee

  const order = buildSellOrder({
    offerer: seller,
    collectionAddress: collection,
    tokenId,
    sellerProceeds,
    royaltyReceiver,
    royaltyAmount,
    platformFee,
    platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
    counter,
    currency,
  })
  const serialized = serializeOrder(order)

  const needsApproval = !isApprovedForAll
  const calls: AgentCall[] | undefined = needsApproval
    ? [
        {
          to: collection,
          data: withBuilderSuffix(
            encodeFunctionData({ abi: ERC1155_ABI, functionName: 'setApprovalForAll', args: [SEAPORT_ADDRESS, true] }),
          ),
          value: '0x0',
        },
      ]
    : undefined

  const listingPostBody: Record<string, unknown> = {
    collectionAddress: collection,
    tokenId,
    seller,
    price: priceTotal.toString(),
    sellerProceeds: sellerProceeds.toString(),
    royaltyReceiver,
    royaltyAmount: royaltyAmount.toString(),
    currency,
    orderComponents: serialized,
    signature: '<signature>',
    expiresAt: Number(order.endTime) * 1000,
  }
  if (input.name) listingPostBody.name = input.name
  if (input.image) listingPostBody.image = input.image
  if (input.creatorAddress) listingPostBody.creatorAddress = input.creatorAddress

  return {
    calls,
    typedData: { domain: SEAPORT_DOMAIN, types: SEAPORT_ORDER_TYPES, primaryType: 'OrderComponents', message: serialized },
    listingPostBody,
    priceTotal,
    sellerProceeds,
    needsApproval,
  }
}
