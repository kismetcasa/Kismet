import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { serverBaseClient } from '@/lib/rpc'
import { SEAPORT_ADDRESS, SEAPORT_ABI, ERC1155_ABI, EIP2981_ABI } from '@/lib/seaport'
import { formatPrice } from '@/lib/inprocess'
import { parseMomentRef } from '@/lib/agent/refs'
import { buildListPlan, priceToBaseUnits } from '@/lib/agent/list'
import type { AgentActionEnvelope } from '@/lib/agent/types'

export const runtime = 'nodejs'

/**
 * Prepare a "list" (Seaport offer) for an AI agent to execute via Base MCP.
 * Read-only and inert: returns the EIP-712 typed data to sign, an optional
 * one-time setApprovalForAll batch, and the /api/listings POST body. No funds
 * move; the listing is created only after the user signs and the order is
 * posted (where it is independently re-validated). See AGENT_COMMERCE_DESIGN.md.
 *
 * Inputs: a moment ref ({ collection, tokenId } or a pasted url), the seller's
 * Base Account, a human `price`, and `currency` ('eth' | 'usdc').
 */
export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`agent-prepare-list:${getClientIp(req)}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as
    | { collection?: unknown; tokenId?: unknown; url?: unknown; account?: unknown; price?: unknown; currency?: unknown; name?: unknown; image?: unknown }
    | null
  if (!body) return errorResponse(400, 'Invalid body')

  const ref = parseMomentRef(body)
  if ('error' in ref) return errorResponse(400, ref.error)
  const collection = ref.collection
  const tokenIdBn = BigInt(ref.tokenId)

  const account = typeof body.account === 'string' ? body.account : ''
  if (!isAddress(account)) return errorResponse(400, 'Invalid account — pass the Base Account address from get_wallets')

  const price = typeof body.price === 'string' ? body.price.trim() : ''
  if (!/^\d+(\.\d+)?$/.test(price) || Number(price) <= 0) {
    return errorResponse(400, 'Invalid price — pass a positive decimal string like "0.01"')
  }
  const currency: 'eth' | 'usdc' | null = body.currency === 'usdc' ? 'usdc' : body.currency === 'eth' ? 'eth' : null
  if (!currency) return errorResponse(400, 'currency must be "eth" or "usdc"')

  const name = typeof body.name === 'string' ? body.name : undefined
  const image = typeof body.image === 'string' ? body.image : undefined

  const priceTotal = priceToBaseUnits(price, currency)
  const client = serverBaseClient()

  // Ownership + approval + counter in parallel. Royalty is read separately
  // because a collection without EIP-2981 reverts (→ zero royalty, like ListButton).
  let balance: bigint
  let isApprovedForAll: boolean
  let counter: bigint
  try {
    const [bal, approved, ctr] = await Promise.all([
      client.readContract({ address: collection, abi: ERC1155_ABI, functionName: 'balanceOf', args: [account as Address, tokenIdBn] }),
      client.readContract({ address: collection, abi: ERC1155_ABI, functionName: 'isApprovedForAll', args: [account as Address, SEAPORT_ADDRESS] }),
      client.readContract({ address: SEAPORT_ADDRESS, abi: SEAPORT_ABI, functionName: 'getCounter', args: [account as Address] }),
    ])
    balance = bal as bigint
    isApprovedForAll = approved as boolean
    counter = ctr as bigint
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : 'Chain read failed — try again')
  }
  if (balance <= 0n) {
    return errorResponse(403, "You don't hold this token, so you can't list it")
  }

  let royaltyReceiver = account as Address
  let royaltyAmount = 0n
  try {
    const r = (await client.readContract({
      address: collection,
      abi: EIP2981_ABI,
      functionName: 'royaltyInfo',
      args: [tokenIdBn, priceTotal],
    })) as readonly [Address, bigint]
    royaltyReceiver = r[0]
    royaltyAmount = r[1]
  } catch {
    // Collection doesn't implement EIP-2981 — list with zero royalty.
  }
  if (royaltyAmount > priceTotal) {
    return errorResponse(409, 'On-chain royalty exceeds the listing price')
  }

  const plan = buildListPlan({
    collection,
    tokenId: ref.tokenId,
    seller: account as Address,
    currency,
    price,
    royaltyReceiver,
    royaltyAmount,
    counter,
    isApprovedForAll,
    name,
    image,
  })

  const priceLabel = formatPrice(plan.priceTotal.toString(), currency)
  const approvalNote = plan.needsApproval
    ? ' First listing on this collection — run the one-time marketplace approval (send_calls), then sign the order.'
    : ' Sign the order to list.'
  const summary = `List token #${ref.tokenId} for ${priceLabel}.${approvalNote}`

  const envelope: AgentActionEnvelope = {
    chain: 'base',
    action: 'list',
    ...(plan.calls ? { calls: plan.calls } : {}),
    typedData: plan.typedData,
    summary,
    record: {
      method: 'POST',
      url: '/api/listings',
      bodyTemplate: plan.listingPostBody,
    },
  }

  return NextResponse.json(envelope, { headers: { 'Cache-Control': 'private, no-store' } })
}
