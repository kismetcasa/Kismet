import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress } from '@/lib/address'
import { errorResponse } from '@/lib/apiResponse'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { serverBaseClient } from '@/lib/rpc'
import { ERC20_ABI, USDC_BASE, ZORA_ERC20_MINTER, readMintFeeWithBound } from '@/lib/zoraMint'
import { fetchEligibleTokens } from '@/lib/saleConfig'
import { formatPrice } from '@/lib/inprocess'
import { parseMomentRef } from '@/lib/agent/refs'
import { buildCollectPlan } from '@/lib/agent/collect'
import type { AgentActionEnvelope } from '@/lib/agent/types'

export const runtime = 'nodejs'

// Cap agent-requested quantity. The on-chain sale's per-wallet limit is the
// real gate (enforced by fetchEligibleTokens); this is just a sane upper bound
// so a typo can't build a 10,000× batch the wallet would choke on.
const MAX_AGENT_COLLECT_QUANTITY = 50

/**
 * Prepare a "collect" (primary mint) for an AI agent to execute via Base MCP's
 * send_calls. Read-only and inert: returns the unsigned EIP-5792 batch plus a
 * record hint; moves no funds until the user approves in their Base Account.
 *
 * Authoritative on-chain reads decide the currency + price (never trust the
 * agent's claim), and reuse the tested eligibility reader so we never hand back
 * a mint that would revert (inactive sale, sold out, or per-wallet cap hit).
 *
 * Settlement recording stays on the existing, on-chain-verified /api/collect.
 * See AGENT_COMMERCE_DESIGN.md.
 */
export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`agent-prepare-collect:${getClientIp(req)}`, 60, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as
    | { collection?: unknown; tokenId?: unknown; url?: unknown; account?: unknown; amount?: unknown; comment?: unknown }
    | null
  if (!body) return errorResponse(400, 'Invalid body')

  const ref = parseMomentRef(body)
  if ('error' in ref) return errorResponse(400, ref.error)
  const collection = ref.collection
  const tokenId = BigInt(ref.tokenId)

  // The recipient + payer is the user's Base Account (resolved by the agent via
  // get_wallets). Everything keys off it: mintTo, the on-chain TransferSingle
  // /api/collect verifies, and the per-wallet eligibility check below.
  const account = typeof body.account === 'string' ? body.account : ''
  if (!isAddress(account)) return errorResponse(400, 'Invalid account — pass the Base Account address from get_wallets')

  const amountNum = Number(body.amount ?? 1)
  const quantity =
    Number.isFinite(amountNum) && amountNum > 0 ? BigInt(Math.min(Math.floor(amountNum), MAX_AGENT_COLLECT_QUANTITY)) : 1n
  const comment = typeof body.comment === 'string' && body.comment.length <= 1000 ? body.comment : ''

  const client = serverBaseClient()

  // Determine the live sale authoritatively. fetchEligibleTokens confirms the
  // sale is active, not sold out, and the account hasn't hit its per-wallet
  // cap — for ETH (FixedPriceStrategy) and USDC (ERC20Minter) respectively.
  let currency: 'eth' | 'usdc' | null = null
  let pricePerToken = 0n
  try {
    const [eth] = await fetchEligibleTokens(client, collection, [tokenId], 'eth', account as Address)
    if (eth) {
      currency = 'eth'
      pricePerToken = eth.pricePerToken
    } else {
      const [usdc] = await fetchEligibleTokens(client, collection, [tokenId], 'usdc', account as Address)
      if (usdc) {
        currency = 'usdc'
        pricePerToken = usdc.pricePerToken
      }
    }
  } catch {
    return errorResponse(502, 'Could not read the sale config from chain — try again')
  }
  if (!currency) {
    return errorResponse(
      409,
      'No active sale for this token — it may be unset, sold out, or you have hit the per-wallet mint limit',
    )
  }

  // Remaining live inputs for the pure plan: ETH needs the protocol mint fee;
  // USDC needs the current allowance so we only prepend approve when short.
  let mintFee = 0n
  let usdcAllowance = 0n
  try {
    if (currency === 'eth') {
      // serverBaseClient() is concretely typed to Base, but readMintFeeWithBound
      // accepts viem's default PublicClient — the two don't unify because Base's
      // OP-Stack getBlock formatter widens the block type (the same chain-generic
      // variance lib/permissions.ts documents). The client is structurally a
      // superset; cast to bridge the static-only mismatch.
      mintFee = await readMintFeeWithBound(client as Parameters<typeof readMintFeeWithBound>[0], collection)
    } else {
      usdcAllowance = (await client.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account as Address, ZORA_ERC20_MINTER],
      })) as bigint
    }
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : 'Chain read failed — try again')
  }

  const plan = buildCollectPlan({
    collection,
    tokenId,
    account: account as Address,
    quantity,
    currency,
    pricePerToken,
    comment,
    mintFee,
    usdcAllowance,
  })

  const priceLabel = formatPrice(pricePerToken.toString(), currency)
  const qtyLabel = quantity === 1n ? '' : `${quantity}× `
  const feeNote = currency === 'eth' && mintFee > 0n ? ' (+ protocol mint fee)' : ''
  const approvalNote = plan.approvalIncluded
    ? ' Includes a one-time USDC approval, batched into the same approval.'
    : ''
  const summary = `Collect ${qtyLabel}token #${tokenId.toString()} for ${priceLabel} each${feeNote}.${approvalNote}`

  const envelope: AgentActionEnvelope = {
    chain: 'base',
    action: 'collect',
    calls: plan.calls,
    summary,
    record: {
      method: 'POST',
      url: '/api/collect',
      bodyTemplate: {
        moment: { collectionAddress: collection, tokenId: tokenId.toString(), chainId: 8453 },
        account,
        amount: Number(quantity),
        comment,
        pricePerToken: pricePerToken.toString(),
        currency,
        txHash: '<REPLACE_WITH_send_calls_txHash>',
      },
    },
    caps:
      currency === 'eth'
        ? { maxValueEth: plan.totalValue.toString() }
        : { maxValueUsdc: plan.totalCost.toString() },
  }

  return NextResponse.json(envelope, { headers: { 'Cache-Control': 'private, no-store' } })
}
