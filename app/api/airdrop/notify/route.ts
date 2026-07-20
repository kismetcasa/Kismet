import { NextRequest, NextResponse, after } from 'next/server'
import { decodeEventLog, parseAbi, type Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { recordAirdrop } from '@/lib/airdrops'
import { consumeQuota } from '@/lib/airdrop-quota'
import { isBlacklisted } from '@/lib/blacklist'
import { bestEffort } from '@/lib/bestEffort'
import { recordCollected } from '@/lib/collected'
import { MAX_AIRDROP_RECIPIENTS } from '@/lib/config'
import { getGateConfig } from '@/lib/gate'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { creditValidityOnce, recordPlatformTx } from '@/lib/pass-validity'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { redis } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'
import { errorResponse } from '@/lib/apiResponse'

/**
 * Records an airdrop after the on-chain tx submitted by the user's wallet
 * lands. Companion to `useAirdrop` — the form fires this after
 * `writeContractAsync` resolves so these display surfaces stay populated:
 *
 *   1. ProfileView's airdrops section (read via GET /api/airdrops)
 *   2. Recipient inboxes (one notification per recipient, type=airdrop)
 *   3. The sender's inbox (a self-action "you airdropped …" confirmation)
 *
 * Inprocess's `/api/airdrops` is no longer authoritative for Kismet — we
 * bypass their relay to call Zora's `adminMint` directly, so they never see
 * the airdrop. This endpoint is the local replacement.
 *
 * On-chain verification + idempotency: every claim is verified against the
 * Transfer events on the supplied txHash before any side effect runs, and
 * a (txHash, collection, tokenId, sender) tuple is locked into Redis NX so
 * an attacker who observes a real airdrop tx can't replay it to drain the
 * sender's airdrop quota or pollute their notification log. The chain is
 * the source of truth — body fields that disagree with the receipt fail.
 */

const ERC1155_TRANSFER_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const VERIFY_CACHE_TTL_SECONDS = 300
const IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Verify the on-chain receipt contains TransferSingle events from the
 * specified collection where `operator === sender` (the adminMint caller),
 * `from === 0x0` (real mint, not a re-transfer), and `id === tokenId`.
 *
 * Returns the FULL set of `to` addresses from matching logs as the
 * authoritative recipient list. Fails when any claimed recipient is
 * missing from the on-chain set (caller claim disagrees with reality),
 * but extras present on-chain but not claimed are KEPT — the caller
 * sees the full set so a race-grief attacker can't shrink the recipient
 * list by POSTing first with a subset.
 *
 * Fail-closed on RPC, decode, receipt status, or operator-mismatch.
 */
async function verifyAirdropOnChain(
  txHash: Hex,
  collection: string,
  tokenId: string,
  sender: string,
  claimedRecipients: string[],
): Promise<{ ok: true; verified: Set<string> } | { ok: false }> {
  const cacheKey = `verify:airdrop:${txHash}:${collection}:${tokenId}:${sender}`
  const cached = await redis.get<string>(cacheKey).catch(() => null)
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as string[]
      return { ok: true, verified: new Set(parsed) }
    } catch {
      // Fall through to fresh fetch on cache parse failure.
    }
  }

  try {
    const receipt = await serverBaseClient().getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') return { ok: false }

    const expectedTokenId = BigInt(tokenId)
    const verified = new Set<string>()
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== collection) continue
      let decoded
      try {
        decoded = decodeEventLog({
          abi: ERC1155_TRANSFER_ABI,
          data: log.data,
          topics: log.topics,
        })
      } catch {
        continue
      }
      const { operator, from, to, id } = decoded.args
      // Bind to the caller: only events where the claimed sender was
      // msg.sender of the adminMint call count. Without this an attacker
      // could repost someone else's airdrop tx and claim credit for it.
      if (operator.toLowerCase() !== sender) continue
      if (from !== ZERO_ADDRESS) continue
      if (id !== expectedTokenId) continue
      verified.add(to.toLowerCase())
    }

    // Every claimed recipient must have a matching TransferSingle log.
    // Reject any partial-claim: if the receipt only covers some of the
    // recipients the client sent, the client is making a claim that
    // doesn't match reality.
    const claimedLower = claimedRecipients.map((r) => r.toLowerCase())
    for (const r of claimedLower) {
      if (!verified.has(r)) return { ok: false }
    }

    await redis
      .set(cacheKey, JSON.stringify(Array.from(verified)), { ex: VERIFY_CACHE_TTL_SECONDS })
      .catch(() => {})
    return { ok: true, verified }
  } catch {
    return { ok: false }
  }
}

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
  const rawTokenId = body.tokenId !== undefined && body.tokenId !== null ? String(body.tokenId) : null
  const recipients = Array.isArray(body.recipients) ? body.recipients : []
  const txHash = body.txHash

  if (!sender || !isAddress(sender)) {
    return errorResponse(400, 'Invalid sender')
  }
  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!rawTokenId || !/^\d+$/.test(rawTokenId)) {
    return errorResponse(400, 'Invalid tokenId')
  }
  // Canonicalize tokenId to base-10 minimal form — same pattern as /api/collect.
  // Without this, idempotency keys "01" vs "1" would not collide and a
  // legitimate airdrop could be replayed under a different string form.
  const tokenId = BigInt(rawTokenId).toString()
  if (recipients.length === 0) {
    return errorResponse(400, 'No recipients')
  }
  if (recipients.length > MAX_AIRDROP_RECIPIENTS) {
    return errorResponse(400, 'Too many recipients')
  }
  // txHash is now MANDATORY — it's the proof tying this request to a
  // specific on-chain event. Without it the endpoint trusts body fields,
  // which is exactly the spoof we're closing.
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return errorResponse(400, 'Invalid txHash')
  }

  const validRecipients = recipients
    .filter((r): r is string => typeof r === 'string' && isAddress(r))
    .map((r) => r.toLowerCase())
  if (validRecipients.length === 0) {
    return errorResponse(400, 'No valid recipients')
  }

  // Action-blacklist gate: the on-chain airdrop already happened (Zora
  // adminMint is direct from the sender's wallet, not relayed through us),
  // but a blacklisted sender's airdrop is denied platform-side recording.
  // No quota debit, no notifications, no recordPlatformTx — meaning
  // recipients hold the Pass on-chain but earn no platform validity (admin
  // would have to manually grant via /admin/pass). Matches the policy that
  // blacklisted users can't propagate creator access through their actions.
  if (await isBlacklisted(sender)) {
    return errorResponse(403, 'Address is blocked from airdropping')
  }

  // Verify the receipt contains TransferSingle events matching every
  // claimed recipient with operator === sender. This is the new gate:
  // a malicious caller can't credit themselves for someone else's
  // airdrop tx (operator check), can't credit ghost recipients (set
  // membership), and can't spoof sender to drain a victim's quota
  // (verification fails because victim isn't operator in the attacker's
  // chosen txHash).
  const verifyResult = await verifyAirdropOnChain(
    txHash as Hex,
    collectionAddress,
    tokenId,
    sender,
    validRecipients,
  )
  if (!verifyResult.ok) {
    return errorResponse(403, 'Airdrop not verified on-chain')
  }
  // Use the on-chain set as the authoritative recipient list. Closes a
  // race-grief vector where an attacker watching for the sender's real
  // airdrop tx could win the idempotency lock by POSTing first with a
  // subset of recipients (subset passes the per-claim check), suppressing
  // notifications to the rest. By rebuilding from the receipt instead,
  // every actual on-chain recipient is recorded regardless of which body
  // arrives first.
  const finalRecipients = Array.from(verifyResult.verified)

  // Idempotency lock on (txHash, collection, tokenId, sender). A real
  // airdrop posted twice (Promise.all retry, browser back-button, network
  // hiccup) returns ok=idempotent without re-debiting quota or re-
  // notifying recipients. Lock acquired BEFORE consumeQuota so a
  // retry never double-spends the quota bucket.
  const idemKey = `kismetart:airdrop-idem:${txHash}:${collectionAddress}:${tokenId}:${sender}`
  let acquired: 'OK' | null
  try {
    acquired = (await redis.set(idemKey, '1', {
      nx: true,
      ex: IDEMPOTENCY_TTL_SECONDS,
    })) as 'OK' | null
  } catch (err) {
    console.error('[airdrop-notify] idempotency-lock failed', { txHash, err })
    return errorResponse(503, 'Recording temporarily unavailable')
  }
  if (acquired !== 'OK') {
    return NextResponse.json({ ok: true, idempotent: true })
  }

  // Quota debit is SCOPED to the configured Pass collection — the Season
  // 1 plan (1/day, 5/week per artist) is about throttling the rate Pass
  // NFTs are given away, not about constraining moments airdropped from
  // any other collection. Read gate config per request so a mid-flight
  // admin update (e.g. switching Pass collections between phases)
  // immediately applies to subsequent airdrops.
  const gateConfig = await getGateConfig()
  const isPassAirdrop =
    !!gateConfig.passCollection && gateConfig.passCollection === collectionAddress

  if (isPassAirdrop) {
    const quota = await consumeQuota(sender, finalRecipients.length)
    if (!quota.ok) {
      // Release the idempotency lock claimed above: this airdrop was NOT
      // recorded/credited (quota rejected), so a later retry — once the
      // sender's quota window rolls over — must be free to proceed and credit
      // the recipients, rather than being permanently short-circuited as a dup
      // (the on-chain Pass transfer already happened; the recipients need the
      // validity credit or they can't mint).
      await redis.del(idemKey).catch(() => {})
      return NextResponse.json(
        {
          error:
            quota.reason === 'day_cap'
              ? 'Daily airdrop limit reached'
              : 'Weekly airdrop limit reached',
          reason: quota.reason,
          limits: quota.limits,
          used: quota.used,
        },
        { status: 429 },
      )
    }

    // Credit each recipient SYNCHRONOUSLY — mirrors the fix in /api/collect/route.ts.
    // Airdrops are mints (from = 0x0), so processTransfer cannot taint the tokenId,
    // but the webhook still skips the credit when !platform. The race: Alchemy
    // delivers the TransferSingle events immediately after the tx mines; the sender's
    // client calls /api/airdrop/notify only after seeing the receipt, so the webhook
    // routinely fires first, claims each processedKey with no credit, and never
    // retries — recipients hold the Pass on-chain but have zero validBalance and are
    // blocked from minting. Crediting here (after on-chain verification proved the
    // recipients) removes that race. creditValidityOnce is idempotent via keyCredited,
    // so whichever path fires first wins and the other is a no-op.
    await Promise.all(
      finalRecipients.map((recipient) =>
        creditValidityOnce({
          collection: collectionAddress,
          address: recipient,
          txHash: txHash as string,
          tokenId,
          amount: 1,
        }).catch((err) =>
          console.error('[airdrop-notify] creditValidityOnce failed', { recipient, txHash, err }),
        ),
      ),
    )
  }

  // tokenName lookup is best-effort — kept off the critical path so a meta
  // miss (older moments not indexed yet, Redis hiccup) doesn't drop the
  // record. The notification just renders "an artwork" instead of the title.
  const meta = await getMomentMeta(collectionAddress, tokenId).catch(() => null)
  const tokenName = meta?.name

  const timestamp = Date.now()

  // Record per recipient. Failures are logged (not swallowed) so a Redis
  // hiccup that drops a recipient's record is diagnosable, and the response
  // reports the count actually written rather than an optimistic total.
  const recordResults = await Promise.all(
    finalRecipients.map(async (recipient) => {
      let ok = false
      try {
        await recordAirdrop(sender, {
          collectionAddress,
          tokenId,
          recipient: { address: recipient },
          amount: 1,
          txHash,
          timestamp,
        })
        ok = true
      } catch (err) {
        bestEffort('airdrop-notify.recordAirdrop', { sender, recipient, txHash })(err)
      }
      await recordCollected(recipient, collectionAddress, tokenId, timestamp).catch(
        bestEffort('airdrop-notify.recordCollected', { recipient, collectionAddress, tokenId }),
      )
      return ok
    }),
  )
  const recordedCount = recordResults.filter(Boolean).length

  after(async () => {
    // Everyone the airdrop actually notifies as a recipient — the sender is
    // excluded (a self-airdrop mints to yourself but shouldn't ping your own
    // inbox as an airdropee). Computed once and reused for the sender's count
    // below, so "you airdropped … to N recipients" matches the notifications sent.
    const recipientsExSelf = finalRecipients.filter((recipient) => recipient !== sender)
    // Per-call catch so one failed notification doesn't abort the rest of the
    // batch (Promise.all rejects on the first rejection).
    const notifications = recipientsExSelf.map((recipient) =>
      // Airdropee: "<sender> airdropped you …" (actor set).
      writeNotification({
        type: 'airdrop',
        recipient,
        actor: sender,
        tokenAddress: collectionAddress,
        tokenId,
        ...(tokenName ? { tokenName } : {}),
        amount: 1,
      }).catch(
        bestEffort('airdrop-notify.writeNotification', { recipient, sender, txHash }),
      ),
    )
    // Airdropper's own confirmation — no actor, so it renders as a self-action
    // and clears writeNotification's self-check (which only blocks actor===recipient).
    // `amount` is the count of OTHER recipients, matching who got an airdropee ping.
    notifications.push(
      writeNotification({
        type: 'airdrop',
        recipient: sender,
        tokenAddress: collectionAddress,
        tokenId,
        ...(tokenName ? { tokenName } : {}),
        amount: recipientsExSelf.length,
      }).catch(
        bestEffort('airdrop-notify.writeNotification.sender', { sender, txHash }),
      ),
    )
    await Promise.all(notifications)
  })

  // Flag the airdrop tx as platform-originated so the Pass-transfer webhook
  // credits each recipient with validity when their Transfer event arrives.
  // verifyAirdropOnChain above already proved this tx contains real mints
  // (operator === sender, from === ZERO, recipients verified against logs),
  // so flagging it is safe. No-op for non-Pass airdrops — the webhook
  // filters by configured passCollection, so the flag sits unread for
  // collections that aren't the gate collection. Without this, Season 1
  // airdrops would put Pass NFTs in recipients' wallets but leave their
  // validBalance at 0, blocking them from minting moments despite
  // legitimately holding a Pass.
  // Flag all verified recipients in ONE eval — finalRecipients is the
  // on-chain-verified set rebuilt from the receipt — so the webhook backstop
  // credits exactly them, not any wallet that shared the tx, and a
  // many-recipient airdrop stays a single Redis command (not N).
  after(() =>
    recordPlatformTx(txHash, finalRecipients, tokenId).catch(
      bestEffort('airdrop-notify.recordPlatformTx', { txHash, sender }),
    ),
  )

  return NextResponse.json({ ok: true, recorded: recordedCount })
}
