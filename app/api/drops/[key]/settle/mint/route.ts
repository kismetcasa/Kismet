import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { proxyMintRequest } from '@/lib/mint-proxy'
import { serverBaseClient } from '@/lib/rpc'
import { isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { getDropRecord, getSettleProgress, isDropsEnabled, lockSettle, setSettleProgress } from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * POST /api/drops/{key}/settle/mint { intent } — step 2 of settling: mint the
 * prepared edition. The artist signs a MintIntent over the body …/prepare
 * returned; this forwards THAT body (from Redis, never one from the client)
 * with the signature through the same sponsored mint as /api/mint
 * (lib/mint-proxy: signature, Pass gate, pause, blacklist, quota, relay).
 *
 * The result is recorded here, the moment the relay answers, so a closed tab
 * or a lost response can't lead to a second edition: the next visit resumes
 * at the airdrop. A lock stops a double click from minting twice.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!(await checkRateLimit(`drops-settle:${getClientIp(req)}`, 10, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')
  const dropKey = normalizeEntityKey(raw)

  let body: { intent?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return errorResponse(400, 'Invalid request body')
  }

  const session = await getSessionAddress(req)
  if (!session) return errorResponse(401, 'Sign in to continue')
  const drop = await getDropRecord(dropKey).catch(() => null)
  if (!drop) return errorResponse(404, 'Drop not found — it may have expired')
  if (session.toLowerCase() !== drop.artist) return errorResponse(403, 'Only the artist can settle this drop')

  const lock = await lockSettle(dropKey)
  if (!lock.acquired) return errorResponse(409, 'Already in progress — give it a moment')
  try {
    // Read under the lock: a request that waited out another's mint sees it.
    const progress = await getSettleProgress(dropKey)
    if (!progress) return errorResponse(409, 'Prepare the mint first')
    if (progress.minted) return NextResponse.json({ collection: progress.minted.collection, tokenId: progress.minted.tokenId })

    // Where …/settle starts looking for the airdrop: nothing of this edition
    // can land before the mint is even sent.
    let fromBlock: bigint
    try {
      fromBlock = await serverBaseClient().getBlockNumber()
    } catch (err) {
      return upstreamError(502, 'Could not reach Base — try again shortly', err, 'drops-settle')
    }
    // Same headers (the client IP the mint's rate limit keys on), new body —
    // so not the original's length.
    const headers = new Headers(req.headers)
    headers.delete('content-length')
    const forwarded = new NextRequest(req.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...progress.body, intent: body.intent }),
    })
    const res = await proxyMintRequest(forwarded, 'mint', 'moment/create')
    if (!res.ok) return res
    const data = (await res.json().catch(() => ({}))) as { contractAddress?: unknown; tokenId?: unknown }
    const collection = typeof data.contractAddress === 'string' ? data.contractAddress.toLowerCase() : ''
    const tokenId = data.tokenId === undefined || data.tokenId === null ? '' : String(data.tokenId)
    if (!isAddress(collection) || !/^\d{1,78}$/.test(tokenId)) {
      return errorResponse(502, 'Minted, but the relay did not say which token — contact support before minting again')
    }
    const minted = { collection, tokenId, fromBlock: fromBlock.toString() }
    await setSettleProgress(dropKey, drop.closesAt, { ...progress, minted })
    return NextResponse.json({ collection, tokenId })
  } finally {
    await lock.release()
  }
}
