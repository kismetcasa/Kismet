import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from '@/lib/address'
import { recordAirdrop } from '@/lib/airdrops'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { redis } from '@/lib/redis'

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
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = (await req.json().catch(() => null)) as {
    sender?: string
    collectionAddress?: string
    tokenId?: string | number
    recipients?: string[]
    txHash?: string
  } | null

  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const sender = body.sender?.toLowerCase()
  const collectionAddress = body.collectionAddress?.toLowerCase()
  const tokenId = body.tokenId !== undefined && body.tokenId !== null ? String(body.tokenId) : null
  const recipients = Array.isArray(body.recipients) ? body.recipients : []
  const txHash = body.txHash

  if (!sender || !isAddress(sender)) {
    return NextResponse.json({ error: 'Invalid sender' }, { status: 400 })
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (recipients.length === 0) {
    return NextResponse.json({ error: 'No recipients' }, { status: 400 })
  }
  // Cap to the form's UX ceiling — way more than any real airdrop, but stops
  // a malicious caller from flooding a single sender's log via this endpoint.
  if (recipients.length > 200) {
    return NextResponse.json({ error: 'Too many recipients' }, { status: 400 })
  }
  // Optional but sanity-check the shape so we don't store garbage.
  if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: 'Invalid txHash' }, { status: 400 })
  }

  const validRecipients = recipients
    .filter((r): r is string => typeof r === 'string' && isAddress(r))
    .map((r) => r.toLowerCase())
  if (validRecipients.length === 0) {
    return NextResponse.json({ error: 'No valid recipients' }, { status: 400 })
  }

  // tokenName lookup is best-effort — kept off the critical path so a meta
  // miss (older moments not indexed yet, Redis hiccup) doesn't drop the
  // record. The notification just renders "a moment" instead of the title.
  const meta = await getMomentMeta(collectionAddress, tokenId).catch(() => null)
  const tokenName = meta?.name

  const timestamp = Date.now()

  await Promise.all(
    validRecipients.map(async (recipient) => {
      // Three side effects per recipient, all best-effort:
      //   1. Append to the sender's airdrop log (powers ProfileView's Sent).
      //   2. Insert into the recipient's collected zset so the airdropped
      //      moment appears in their Collected tab — same key the /api/collect
      //      route writes to, so the timeline `?collector=` filter picks it
      //      up without any further changes.
      //   3. Drop an inbox notification (skipped on self-airdrops; the
      //      dedup in writeNotification already covers this but skipping
      //      saves a Redis round-trip).
      try {
        await recordAirdrop(sender, {
          collectionAddress,
          tokenId,
          recipient: { address: recipient },
          amount: 1,
          ...(txHash ? { txHash } : {}),
          timestamp,
        })
      } catch {
        // best-effort
      }
      try {
        await redis.zadd(`kismetart:collected:${recipient}`, {
          score: timestamp,
          member: `${collectionAddress}:${tokenId}`,
        })
      } catch {
        // best-effort
      }
      if (recipient === sender) return
      void writeNotification({
        type: 'airdrop',
        recipient,
        actor: sender,
        tokenAddress: collectionAddress,
        tokenId,
        ...(tokenName ? { tokenName } : {}),
        amount: 1,
      })
    }),
  )

  return NextResponse.json({ ok: true, recorded: validRecipients.length })
}
