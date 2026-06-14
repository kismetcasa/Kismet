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
import { buildCollectBatchPlan, type BatchCollectItem } from '@/lib/agent/collectBatch'
import type { AgentActionEnvelope, AgentRecordHint } from '@/lib/agent/types'

export const runtime = 'nodejs'

// One Base MCP approval can comfortably preview ~20 mints; cap the basket so a
// runaway request can't build an unreviewable batch.
const MAX_BATCH = 20

/**
 * Prepare a multi-collect ("collect these N") for one Base MCP send_calls
 * approval — the execution behind Co-pilot's batch collect and a Scout's
 * Propose mode. Read-only and inert. Resolves each item's live sale (currency +
 * price + eligibility) on-chain so it never builds a mint that would revert,
 * then returns a single EIP-5792 batch plus one /api/collect record per item
 * (all keyed to the shared txHash). See AGENT_COMMERCE_DESIGN.md.
 */
export async function POST(req: NextRequest) {
  if (!(await checkRateLimit(`agent-prepare-collect-batch:${getClientIp(req)}`, 30, 60))) {
    return errorResponse(429, 'Too many requests')
  }

  const body = (await req.json().catch(() => null)) as
    | { items?: Array<{ collection?: unknown; tokenId?: unknown; url?: unknown }>; account?: unknown; recipient?: unknown; comment?: unknown }
    | null
  if (!body || !Array.isArray(body.items) || body.items.length === 0) {
    return errorResponse(400, 'items[] is required')
  }
  if (body.items.length > MAX_BATCH) {
    return errorResponse(400, `Too many items (max ${MAX_BATCH})`)
  }

  // `account` is the SENDER (pays USDC/value, holds the approve). `recipient` is
  // mintTo + the per-wallet-eligibility subject + the recorded owner; it defaults
  // to `account`. They differ for the autonomous Scout (KISMET's spender sends,
  // the user's universal account receives).
  const account = typeof body.account === 'string' ? body.account : ''
  if (!isAddress(account)) return errorResponse(400, 'Invalid account — pass the Base Account address from get_wallets')
  const recipient = typeof body.recipient === 'string' && isAddress(body.recipient) ? body.recipient : account
  const comment = typeof body.comment === 'string' && body.comment.length <= 1000 ? body.comment : ''

  // Resolve refs first; reject the whole batch on a malformed one.
  const refs: Array<{ collection: Address; tokenId: bigint }> = []
  for (const raw of body.items) {
    const ref = parseMomentRef(raw)
    if ('error' in ref) return errorResponse(400, `Invalid item: ${ref.error}`)
    refs.push({ collection: ref.collection, tokenId: BigInt(ref.tokenId) })
  }

  const client = serverBaseClient()

  // Resolve each item's live sale + collect the per-collection ETH mint fee.
  // (Per-item reads; fine for a <=20 basket. A future optimization can group by
  // collection into a single multicall.)
  const items: BatchCollectItem[] = []
  const skipped: Array<{ collection: string; tokenId: string; reason: string }> = []
  const mintFeeCache = new Map<string, bigint>()
  try {
    for (const ref of refs) {
      let currency: 'eth' | 'usdc' | null = null
      let pricePerToken = 0n
      const [eth] = await fetchEligibleTokens(client, ref.collection, [ref.tokenId], 'eth', recipient as Address)
      if (eth) {
        currency = 'eth'
        pricePerToken = eth.pricePerToken
      } else {
        const [usdc] = await fetchEligibleTokens(client, ref.collection, [ref.tokenId], 'usdc', recipient as Address)
        if (usdc) {
          currency = 'usdc'
          pricePerToken = usdc.pricePerToken
        }
      }
      if (!currency) {
        skipped.push({ collection: ref.collection, tokenId: ref.tokenId.toString(), reason: 'no active sale / sold out / per-wallet limit' })
        continue
      }
      let mintFee = 0n
      if (currency === 'eth') {
        const key = ref.collection.toLowerCase()
        const cached = mintFeeCache.get(key)
        if (cached !== undefined) {
          mintFee = cached
        } else {
          mintFee = await readMintFeeWithBound(client as Parameters<typeof readMintFeeWithBound>[0], ref.collection)
          mintFeeCache.set(key, mintFee)
        }
      }
      items.push({ collection: ref.collection, tokenId: ref.tokenId, quantity: 1n, currency, pricePerToken, mintFee, comment })
    }
  } catch (err) {
    return errorResponse(502, err instanceof Error ? err.message : 'Chain read failed — try again')
  }

  if (items.length === 0) {
    return errorResponse(409, 'None of the requested items are currently collectable')
  }

  // One summed USDC allowance read for the whole batch.
  const totalUsdc = items.filter((i) => i.currency === 'usdc').reduce((s, i) => s + i.pricePerToken * i.quantity, 0n)
  let usdcAllowance = 0n
  if (totalUsdc > 0n) {
    try {
      usdcAllowance = (await client.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [account as Address, ZORA_ERC20_MINTER],
      })) as bigint
    } catch (err) {
      return errorResponse(502, err instanceof Error ? err.message : 'Chain read failed — try again')
    }
  }

  const plan = buildCollectBatchPlan({ account: account as Address, recipient: recipient as Address, items, usdcAllowance })

  const records: AgentRecordHint[] = items.map((it) => ({
    method: 'POST',
    url: '/api/collect',
    bodyTemplate: {
      moment: { collectionAddress: it.collection, tokenId: it.tokenId.toString(), chainId: 8453 },
      account: recipient,
      amount: Number(it.quantity),
      comment,
      pricePerToken: it.pricePerToken.toString(),
      currency: it.currency,
      txHash: '<REPLACE_WITH_send_calls_txHash>',
    },
  }))

  const ethTotalLabel = plan.totalNativeValue > 0n ? formatPrice(plan.totalNativeValue.toString(), 'eth') : ''
  const usdcTotalLabel = plan.totalUsdcCost > 0n ? formatPrice(plan.totalUsdcCost.toString(), 'usdc') : ''
  const totalLabel = [usdcTotalLabel, ethTotalLabel].filter(Boolean).join(' + ')
  const skipNote = skipped.length > 0 ? ` Skipped ${skipped.length} unavailable.` : ''
  const summary = `Collect ${items.length} moment${items.length === 1 ? '' : 's'} for ${totalLabel || 'free'} in one approval.${skipNote}`

  const envelope: AgentActionEnvelope = {
    chain: 'base',
    action: 'collect',
    calls: plan.calls,
    summary,
    records,
    // A basket can mix ETH and USDC items, so surface BOTH ceilings — collapsing
    // to one currency would silently drop the other's spend cap.
    caps: {
      ...(plan.totalNativeValue > 0n ? { maxValueEth: plan.totalNativeValue.toString() } : {}),
      ...(plan.totalUsdcCost > 0n ? { maxValueUsdc: plan.totalUsdcCost.toString() } : {}),
    },
  }

  return NextResponse.json({ ...envelope, skipped }, { headers: { 'Cache-Control': 'private, no-store' } })
}
