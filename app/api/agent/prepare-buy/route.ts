import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { serverBaseClient } from '@/lib/rpc'
import { getListing } from '@/lib/listings'
import { SEAPORT_ADDRESS } from '@/lib/seaport'
import { ERC20_ABI, USDC_BASE } from '@/lib/zoraMint'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { buildBuyPlan } from '@/lib/agent/buy'
import type { AgentActionEnvelope } from '@/lib/agent/types'

export const runtime = 'nodejs'

/**
 * Prepare a "buy" (Seaport fulfill) for an AI agent to execute via Base MCP's
 * send_calls. Read-only and inert: returns the unsigned EIP-5792 batch plus a
 * record hint; moves no funds until the user approves in their Base Account.
 *
 * The listing must be active and not expired, and the buyer can't be the
 * seller — the same gates BuyButton applies. Marking the order-book listing
 * "filled" afterward stays on the existing /api/listings/[id] PATCH, which
 * re-decodes OrderFulfilled from the txHash and requires a buyer signature
 * (surfaced as record.preSign). See AGENT_COMMERCE_DESIGN.md.
 */
export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`agent-prepare-buy:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as { listingId?: unknown; account?: unknown } | null
  if (!body) return errorResponse(400, 'Invalid body')

  const listingId = typeof body.listingId === 'string' ? body.listingId : ''
  if (!listingId) return errorResponse(400, 'listingId is required')

  const account = typeof body.account === 'string' ? body.account : ''
  if (!isAddress(account)) return errorResponse(400, 'Invalid account — pass the Base Account address from get_wallets')

  const listing = await getListing(listingId)
  if (!listing) return errorResponse(404, 'Listing not found')
  if (listing.status !== 'active' || listing.expiresAt <= Date.now()) {
    return errorResponse(409, 'Listing is not active (filled, cancelled, or expired)')
  }
  if (listing.seller.toLowerCase() === account.toLowerCase()) {
    return errorResponse(400, 'You cannot buy your own listing')
  }

  const currency: 'eth' | 'usdc' = listing.currency ?? 'eth'

  // USDC fulfillment pulls funds via Seaport, so the buyer needs an allowance.
  // Read it so we only prepend approve when short.
  let seaportUsdcAllowance = 0n
  if (currency === 'usdc') {
    try {
      seaportUsdcAllowance = (await serverBaseClient().readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account as Address, SEAPORT_ADDRESS],
      })) as bigint
    } catch (err) {
      return errorResponse(502, err instanceof Error ? err.message : 'Chain read failed — try again')
    }
  }

  const plan = buildBuyPlan({ listing, seaportUsdcAllowance })

  const priceLabel = formatPrice(listing.price, currency)
  const itemLabel = listing.name ? `“${listing.name}”` : `token #${listing.tokenId}`
  const approvalNote = plan.approvalIncluded
    ? ' Includes a one-time USDC approval, batched into the same approval.'
    : ''
  const summary = `Buy ${itemLabel} from ${shortAddress(listing.seller)} for ${priceLabel}.${approvalNote}`

  const envelope: AgentActionEnvelope = {
    chain: 'base',
    action: 'buy',
    calls: plan.calls,
    summary,
    record: {
      method: 'PATCH',
      url: `/api/listings/${listing.id}`,
      preSign: {
        noncePath: `/api/profile/${account}/nonce`,
        messageTemplate: `Mark Kismet listing filled\nListing: ${listing.id}\nBuyer: ${account.toLowerCase()}\nNonce: <nonce>`,
        via: 'personal_sign',
      },
      bodyTemplate: {
        status: 'filled',
        signer: account,
        nonce: '<nonce>',
        signature: '<signature>',
        txHash: '<REPLACE_WITH_send_calls_txHash>',
      },
    },
    caps: {
      maxValue: plan.price.toString(),
      currency,
    },
  }

  return NextResponse.json(envelope, { headers: { 'Cache-Control': 'private, no-store' } })
}
