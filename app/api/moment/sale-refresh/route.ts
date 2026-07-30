import { NextRequest, NextResponse } from 'next/server'
import type { Address } from 'viem'
import { isAddress, isValidTokenId } from '@/lib/address'
import { onchainSaleConfigFallback } from '@/lib/saleConfig'
import { recordSaleEnds } from '@/lib/saleEnds'
import { serverBaseClient } from '@/lib/rpc'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'
import { bestEffort } from '@/lib/bestEffort'

/**
 * Re-sync the Redis sale indexes (ending-soon + free-mint, lib/saleEnds) for
 * one token from CHAIN truth. Called by the sale-window editor right after
 * its callSale receipt lands — the browse-time write-throughs in /api/moment
 * and /api/moments would converge eventually, but only when someone next
 * browses the token, and a drop rescheduled into the future would otherwise
 * linger in the ending-soon feed until then.
 *
 * Deliberately UNAUTHENTICATED: the request names a token, never supplies
 * sale data — the config written is whatever the chain says right now, read
 * server-side. The worst a caller can do is refresh an index entry to its
 * already-correct value, so a signature would protect nothing. Rate-limited
 * to bound the RPC + Redis spend.
 *
 * The Redis write is awaited (not after()) — it IS this route's job, and a
 * serverless freeze after an early return would drop it.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`sale-refresh:${ip}`, 20, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  let body: { collectionAddress?: string; tokenId?: string }
  try {
    body = await req.json()
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  const { collectionAddress, tokenId } = body
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!tokenId || !isValidTokenId(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }

  const saleConfig = await onchainSaleConfigFallback(
    serverBaseClient(),
    collectionAddress as Address,
    BigInt(tokenId),
  )

  // config === null (no readable sale row / RPC failure) leaves both indexes
  // untouched inside recordSaleEnds — a blip can never erase a live entry.
  await recordSaleEnds([
    {
      key: `${collectionAddress.toLowerCase()}:${BigInt(tokenId).toString()}`,
      config: saleConfig,
    },
  ]).catch(bestEffort('sale-refresh.recordSaleEnds'))

  return NextResponse.json({ ok: true, saleConfig })
}
