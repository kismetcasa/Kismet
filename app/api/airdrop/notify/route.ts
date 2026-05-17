import { NextRequest, NextResponse, after } from 'next/server'
import { isAddress } from '@/lib/address'
import { recordAirdrop } from '@/lib/airdrops'
import { recordCollected } from '@/lib/collected'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Records an airdrop after the on-chain tx submitted by the user's wallet
 * lands. Companion to `useAirdrop` — the form fires this after
 * `writeContractAsync` resolves so two display surfaces stay populated:
 *
 *   1. ProfileView's airdrops section (read via GET /api/airdrops)
 *   2. Recipient inboxes (one notification per recipient, type=airdrop)
 *
 * Inprocess's `/api/airdrops` is no longer authoritative for Kismet — we
 * bypass their relay to call Zora's `adminMint` directly, so they never see
 * the airdrop. This endpoint is the local replacement.
 *
 * Best-effort, like /api/collect: failures here don't undo the on-chain
 * mint and the client doesn't gate UI off the response. Validation rejects
 * obviously bad input but no on-chain receipt verification — same trust
 * model the other write-side notify endpoints use.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  const allowed = await checkRateLimit(`airdrop-notify:${ip}`, 30, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = (await req.json().catch(() => null)) as {
    sender?: string
    collectionAddress?: string
    tokenId?: string | number
    recipients?: string[]
    txHash?: string
  } | null

  if (!body) return errorResponse(400, 'Invalid body')

  const sender = body.sender?.toLowerCase()
  const collectionAddress = body.collectionAddress?.toLowerCase()
  const tokenId = body.tokenId !== undefined && body.tokenId !== null ? String(body.tokenId) : null
  const recipients = Array.isArray(body.recipients) ? body.recipients : []
  const txHash = body.txHash

  if (!sender || !isAddress(sender)) {
    return errorResponse(400, 'Invalid sender')
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  if (recipients.length === 0) {
    return errorResponse(400, 'No recipients')
  }
  // Cap to the form's UX ceiling — way more than any real airdrop, but stops
  // a malicious caller from flooding a single sender's log via this endpoint.
  if (recipients.length > 200) {
    return errorResponse(400, 'Too many recipients')
  }
  // Optional but sanity-check the shape so we don't store garbage.
  if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return errorResponse(400, 'Invalid txHash')
  }

  const validRecipients = recipients
    .filter((r): r is string => typeof r === 'string' && isAddress(r))
    .map((r) => r.toLowerCase())
  if (validRecipients.length === 0) {
    return errorResponse(400, 'No valid recipients')
  }

  // tokenName lookup is best-effort — kept off the critical path so a meta
  // miss (older moments not indexed yet, Redis hiccup) doesn't drop the
  // record. The notification just renders "a moment" instead of the title.
  const meta = await getMomentMeta(collectionAddress, tokenId).catch(() => null)
  const tokenName = meta?.name

  const timestamp = Date.now()

  await Promise.all(
    validRecipients.map(async (recipient) => {
      try {
        await recordAirdrop(sender, {
          collectionAddress,
          tokenId,
          recipient: { address: recipient },
          amount: 1,
          ...(txHash ? { txHash } : {}),
          timestamp,
        })
      } catch {}
      try {
        await recordCollected(recipient, collectionAddress, tokenId, timestamp)
      } catch {}
    }),
  )

  after(async () => {
    await Promise.all(
      validRecipients
        .filter((recipient) => recipient !== sender)
        .map((recipient) =>
          writeNotification({
            type: 'airdrop',
            recipient,
            actor: sender,
            tokenAddress: collectionAddress,
            tokenId,
            ...(tokenName ? { tokenName } : {}),
            amount: 1,
          }),
        ),
    )
  })

  return NextResponse.json({ ok: true, recorded: validRecipients.length })
}
