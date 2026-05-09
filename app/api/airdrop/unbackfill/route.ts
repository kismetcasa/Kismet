import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage } from 'viem'
import { isAddress } from '@/lib/address'
import { removeAirdropEntries } from '@/lib/airdrops'
import { ADMIN_ADDRESS } from '@/lib/config'
import { redis } from '@/lib/redis'

const SESSION_TTL = 4 * 60 * 60 * 1000

async function verifyAdminSession(body: {
  signature?: string
  timestamp?: number
}): Promise<{ error: string; status: number } | null> {
  if (!ADMIN_ADDRESS) return { error: 'Admin not configured', status: 403 }
  if (!body.signature || body.timestamp == null) {
    return { error: 'signature and timestamp required', status: 400 }
  }
  if (Date.now() - body.timestamp > SESSION_TTL) {
    return { error: 'Session expired — please sign in again', status: 401 }
  }
  const message = `Kismet Art admin session\nAddress: ${ADMIN_ADDRESS}\nTimestamp: ${body.timestamp}`
  const verified = await verifyMessage({
    address: ADMIN_ADDRESS as `0x${string}`,
    message,
    signature: body.signature as `0x${string}`,
  })
  if (!verified) return { error: 'Signature verification failed', status: 401 }
  return null
}

/**
 * Admin-gated reversal of a single airdrop backfill entry. Targets the
 * exact (sender, collection, tokenId, recipient) tuple — narrow on
 * purpose so a typo in one field can't sweep an unrelated row out of
 * the log. Removes:
 *
 *   1. Every matching row from kismetart:airdrops:sender:<sender>
 *      (multiple rows are possible if a backfill was run twice; we
 *      remove all of them).
 *   2. The recipient's collected zset member for that (collection,
 *      tokenId), if present. Live mints could legitimately have put
 *      it there too — but for the cleanup case we want it gone, and
 *      the recipient can re-collect to restore. The trade-off is
 *      conservative: an admin only invokes this to undo a bad
 *      backfill, not to mass-prune live state.
 *
 * The `airdrop` notification in the recipient's inbox is left alone:
 * once delivered, edits to a notification feel weird, and the row
 * carries no power on its own (it's just a UI receipt).
 *
 * Auth: same admin-session signed message every other admin route
 * uses. Body shape mirrors /api/airdrop/backfill so the admin UI can
 * reuse its inputs.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    signature?: string
    timestamp?: number
    sender?: string
    collectionAddress?: string
    tokenId?: string | number
    recipient?: string
  } | null
  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const authErr = await verifyAdminSession(body)
  if (authErr) return NextResponse.json({ error: authErr.error }, { status: authErr.status })

  const sender = body.sender?.toLowerCase()
  const collectionAddress = body.collectionAddress?.toLowerCase()
  const tokenId = body.tokenId !== undefined && body.tokenId !== null
    ? String(body.tokenId)
    : null
  const recipient = body.recipient?.toLowerCase()

  if (!sender || !isAddress(sender)) {
    return NextResponse.json({ error: 'Invalid sender' }, { status: 400 })
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (!recipient || !isAddress(recipient)) {
    return NextResponse.json({ error: 'Invalid recipient' }, { status: 400 })
  }

  const removedFromLog = await removeAirdropEntries(sender, {
    collectionAddress,
    tokenId,
    recipient,
  })

  // Pull the moment off the recipient's collected zset too. zrem
  // returns the number of members removed (0 or 1).
  let removedFromCollected = 0
  try {
    removedFromCollected = await redis.zrem(
      `kismetart:collected:${recipient}`,
      `${collectionAddress}:${tokenId}`,
    ) as number
  } catch {
    // best-effort
  }

  return NextResponse.json({
    ok: true,
    removedFromLog,
    removedFromCollected,
  })
}
