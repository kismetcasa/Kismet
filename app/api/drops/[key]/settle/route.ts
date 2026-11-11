import { NextRequest, NextResponse } from 'next/server'
import { getAddress, isHex, type Hex } from 'viem'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getSessionAddress } from '@/lib/session'
import { errorResponse, upstreamError } from '@/lib/apiResponse'
import { serverBaseClient } from '@/lib/rpc'
import { isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { checkAirdropTx, findAirdrop } from '@/lib/dropSettlement'
import { getSettlements, writeSettlement } from '@/lib/arkiv/drops'
import {
  clearSettleProgress,
  getDropRecord,
  getSettleProgress,
  invalidateDropReads,
  isDropsEnabled,
  lockSettle,
} from '@/lib/dropsStore'

export const runtime = 'nodejs'

/**
 * POST /api/drops/{key}/settle { txHash? } — step 3 of settling: record that
 * the drop was delivered. Nothing is taken on trust: a transaction counts only
 * if it minted the prepared edition from 0x0 to EVERY recipient, by the artist
 * (TransferSingle's operator) — the matcher the airdrop flow already confirms
 * airdrops with (lib/dropSettlement, on lib/airdropLanded matchAirdropTx). Then a readonly
 * `kismet.settlement.v1` entity links the drop to its Base token for everyone.
 *
 * With `txHash` (the airdrop the artist just sent), that transaction is
 * checked. Without one, the chain answers: the edition is minted only by its
 * airdrop (its sale closed at creation), so a fully minted edition means the
 * airdrop landed, and its transaction is found from the block the mint
 * started at. This is how a settle that was interrupted after the airdrop
 * resumes, from any device, instead of offering a second airdrop (which
 * would revert: the supply is used up). `{ delivered: false }` means the
 * airdrop hasn't happened yet.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  if (!(await checkRateLimit(`drops-settle:${getClientIp(req)}`, 10, 60))) return errorResponse(429, 'Too many requests')
  if (!isDropsEnabled()) return errorResponse(404, 'Not found')

  const { key: raw } = await params
  if (!isEntityKey(raw)) return errorResponse(400, 'Invalid drop key')
  const dropKey = normalizeEntityKey(raw)

  let body: { txHash?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return errorResponse(400, 'Invalid request body')
  }
  let txHash: Hex | null = null
  if (body.txHash !== undefined) {
    if (typeof body.txHash !== 'string' || !isHex(body.txHash) || body.txHash.length !== 66) {
      return errorResponse(400, 'Invalid transaction hash')
    }
    txHash = body.txHash.toLowerCase() as Hex
  }

  const session = await getSessionAddress(req)
  if (!session) return errorResponse(401, 'Sign in to continue')
  const drop = await getDropRecord(dropKey).catch(() => null)
  if (!drop) return errorResponse(404, 'Drop not found — it may have expired')
  if (session.toLowerCase() !== drop.artist) return errorResponse(403, 'Only the artist can settle this drop')

  const lock = await lockSettle(dropKey)
  if (!lock.acquired) return errorResponse(409, 'Already in progress — give it a moment')
  try {
    // Read under the lock: a request that waited out another's record sees it.
    const progress = await getSettleProgress(dropKey)
    if (!progress?.minted) {
      const recorded = (await getSettlements([dropKey]).catch(() => null))?.get(dropKey)
      if (recorded) return NextResponse.json({ delivered: true, collection: recorded.collection, tokenId: recorded.tokenId })
      return errorResponse(409, 'Mint the edition first')
    }
    const { minted, recipients } = progress

    let found: Hex | 'not-yet' | null
    try {
      const client = serverBaseClient()
      const want = { ...minted, recipients, artist: drop.artist }
      found = txHash ? await checkAirdropTx(client, txHash, want) : await findAirdrop(client, want)
    } catch (err) {
      return upstreamError(502, 'Could not read Base — try again shortly', err, 'drops-settle')
    }
    if (found === 'not-yet') return NextResponse.json({ delivered: false })
    if (!found) {
      return errorResponse(
        409,
        txHash
          ? 'That transaction did not deliver the edition to every recipient'
          : 'The edition was minted outside this drop’s airdrop — contact support',
      )
    }

    try {
      await writeSettlement({
        dropKey,
        dropClosesAt: drop.closesAt,
        artist: getAddress(drop.artist),
        collection: getAddress(minted.collection),
        tokenId: BigInt(minted.tokenId),
        airdropTx: found,
        recipients: recipients.length,
      })
    } catch (err) {
      return upstreamError(503, 'Delivered on Base, but recording it on Arkiv failed — try again', err, 'drops-settle')
    }
    await clearSettleProgress(dropKey).catch(() => {})
    invalidateDropReads(dropKey)
    return NextResponse.json({ delivered: true, collection: minted.collection, tokenId: minted.tokenId })
  } finally {
    await lock.release()
  }
}
