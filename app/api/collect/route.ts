import { NextRequest, NextResponse, after } from 'next/server'
import { decodeEventLog, parseAbi, type Address, type Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { isPlatformCollectComment } from '@/lib/inprocess'
import { redis, TRENDING_KEY, TRENDING_LATEST_KEY } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { recordCollected } from '@/lib/collected'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { serverBaseClient } from '@/lib/rpc'
import { readSalePricePerToken } from '@/lib/saleConfig'
import { errorResponse } from '@/lib/apiResponse'
import { bestEffort } from '@/lib/bestEffort'
import {
  creditValidityOnce,
  denyUnsanctionedAcquisition,
  recordPlatformTx,
} from '@/lib/pass-validity'
import { getGateConfig } from '@/lib/gate'
import { moderationSubject, verifyGiftClaim } from '@/lib/gift'
import { isBlacklisted } from '@/lib/blacklist'
import { isPassBlacklisted } from '@/lib/pass-blacklist'
import { getSessionAddress } from '@/lib/session'

// All mint paths in this app emit ERC1155 TransferSingle: per-token
// 1155.mint() (single + collect-all ETH legs) and ERC20Minter.mint()
// (single + collect-all USDC legs). We don't decode TransferBatch since
// nothing in this codebase produces it. Add it here only when a code
// path that emits it is introduced.
const ERC1155_TRANSFER_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
])

// Cache verification verdict so atomic-bundle batches (where N records share
// one txHash) only hit RPC once per (tx, collection, token, account) tuple.
const VERIFY_CACHE_TTL_SECONDS = 300

// Idempotency window for (tx, collection, token, account). After a successful
// record, repeat POSTs return ok-without-side-effects so an attacker (or buggy
// client) can't inflate trending or flood notifications by replaying the same
// legitimate mint. 30 days covers the realistic re-submit horizon while
// keeping the keyspace bounded.
const IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60

// Confirm the on-chain receipt shows `account` minting `tokenId` from
// `collection`, and return the tx's payer (`receipt.from`) so a gift claim can
// be proved against it. Fail-closed: any RPC, decode, or no-match path returns
// { ok: false }.
async function verifyMintOnChain(
  txHash: Hex,
  collection: string,
  tokenId: string,
  account: string,
): Promise<{ ok: false } | { ok: true; from: string; units: number }> {
  // Cache the receipt's `from` alongside the verdict so the gift-claim proof
  // below survives a cache hit. Legacy '1'/'0' entries written before this
  // change still parse: '1' means verified with an unknown payer, which only
  // costs an unproven gift claim its attribution for one TTL window (the
  // collect itself, its credit, and its collected-list entry are unaffected).
  //
  // String() normalization is load-bearing, not defensive: Upstash SETs '1'
  // unchanged but JSON-PARSES it back on GET as the NUMBER 1, so the previous
  // `cached === '1'` never matched and this cache never hit — every verified
  // collect re-fetched its receipt from RPC. Same trap lib/gateFlags.isFlagSet
  // exists for (see scripts/verify-gate-flags.ts). The `1:<payer>` form below
  // is non-numeric so it round-trips as a string either way.
  const cacheKey = `verify:collect:${txHash}:${collection}:${tokenId}:${account}`
  const cached = await redis.get<string | number>(cacheKey).catch(() => null)
  const cachedStr = cached == null ? null : String(cached)
  if (cachedStr === '0') return { ok: false }
  // Legacy '1' — verified, payer and quantity unknown. Costs an unproven gift
  // claim its attribution, and makes a denial mark the minimum 1 unit, for one
  // 5-minute TTL window after deploy.
  if (cachedStr === '1') return { ok: true, from: '', units: 1 }
  if (cachedStr?.startsWith('1:')) {
    const [, payer = '', units = '1'] = cachedStr.split(':')
    return { ok: true, from: payer, units: Math.max(1, parseInt(units, 10) || 1) }
  }

  try {
    const receipt = await serverBaseClient().getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      await redis.set(cacheKey, '0', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
      return { ok: false }
    }
    const payer = receipt.from.toLowerCase()

    const expectedTokenId = BigInt(tokenId)
    for (const log of receipt.logs) {
      // The matching log MUST originate from the collection contract — this
      // blocks an attacker from passing a txHash whose only TransferSingle
      // is on an unrelated 1155.
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
      const { from, to, id, value } = decoded.args
      if (
        from === '0x0000000000000000000000000000000000000000' &&
        to.toLowerCase() === account &&
        id === expectedTokenId
      ) {
        // The ON-CHAIN quantity, not the client's `amount`. Used only to size a
        // policy denial (denyUnsanctionedAcquisition), where a client-supplied
        // number must never decide how many units get marked. Clamped to >= 1
        // (a zero-value log can't match a real mint, and 0 would mark nothing)
        // and bounded so a pathological value can't write an absurd count.
        const units = value > 0n && value < 1_000_000n ? Number(value) : 1
        await redis
          .set(cacheKey, `1:${payer}:${units}`, { ex: VERIFY_CACHE_TTL_SECONDS })
          .catch(() => {})
        return { ok: true, from: payer, units }
      }
    }

    await redis.set(cacheKey, '0', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
    return { ok: false }
  } catch {
    // RPC failure: don't cache (transient).
    return { ok: false }
  }
}

/**
 * Records a successful direct mint. The on-chain mint is submitted by the
 * user's wallet (useDirectCollect or useCollectAll); this endpoint bumps
 * trending, appends to the collector's owned list, and notifies the creator.
 * Every claim is verified against the on-chain receipt before crediting —
 * an unsigned POST cannot inflate trending or fake notifications.
 */
export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  // 60/min covers a full MAX_COLLECT_ALL_BATCH (20) collect-all plus normal
  // per-token collects from the same NAT in the same minute window. Without
  // the headroom, a legitimate batch consumes the cap and blocks shared-IP
  // peers (offices, mobile networks) for ~60s.
  const allowed = await checkRateLimit(`collect:${ip}`, 60, 60)
  if (!allowed) return errorResponse(429, 'Too many requests')

  const body = (await req.json().catch(() => null)) as {
    moment?: { collectionAddress?: string; tokenId?: string }
    account?: string
    /** Collect-and-gift attribution: the wallet that PAID for a mint whose
     *  recipient (`account`) is someone else. Untrusted — proved below
     *  against the receipt's payer or the SIWE session, and dropped when
     *  neither matches (see lib/gift.verifyGiftClaim). */
    giftedBy?: string
    amount?: number
    comment?: string
    pricePerToken?: string
    currency?: 'eth' | 'usdc'
    txHash?: string
  } | null

  if (!body) return errorResponse(400, 'Invalid body')

  const collectionAddress = body.moment?.collectionAddress
  const rawTokenId = body.moment?.tokenId
  const account = body.account?.toLowerCase()
  const claimedGiftedBy = typeof body.giftedBy === 'string' ? body.giftedBy : null
  const amount = Number(body.amount ?? 1)
  // Validate comment shape + length before persisting it on the notification.
  // 1000 chars is far above any plausible human-written collect comment and
  // bounds the storage cost a malicious client could impose on a creator's
  // notification feed by replaying garbage long strings.
  const comment =
    typeof body.comment === 'string' && body.comment.length <= 1000
      ? body.comment
      : undefined
  // Validate price as a non-negative decimal of plausible size before storing
  // it on the notification — otherwise a malicious client could record a
  // fictional "9999 ETH" price to fake "big collect" social proof. 30 digits
  // comfortably exceeds 2^96 (uint96 pricePerToken max) without imposing a
  // semantic cap; the strict-equality on-chain check already prevents the
  // user from actually paying anything other than the real price.
  const pricePerToken =
    typeof body.pricePerToken === 'string' && /^\d{1,30}$/.test(body.pricePerToken)
      ? body.pricePerToken
      : undefined
  const currency = body.currency === 'usdc' || body.currency === 'eth' ? body.currency : undefined
  const txHash = body.txHash

  if (!collectionAddress || !isAddress(collectionAddress)) {
    return errorResponse(400, 'Invalid collectionAddress')
  }
  if (!rawTokenId || !/^\d+$/.test(String(rawTokenId))) {
    return errorResponse(400, 'Invalid tokenId')
  }
  // Canonicalize the tokenId to its base-10 minimal form. The regex accepts
  // leading zeros ("01", "0000001"), and all such strings are BigInt-equal —
  // but the Redis keys downstream (idempotency, trending, collected,
  // notification) use the literal string as part of their member. Without
  // normalization, an attacker who legitimately minted token 1 could replay
  // /api/collect with tokenId="01", "001", … and bypass the per-tuple
  // idempotency lock to inflate trending or flood notifications.
  const tokenId = BigInt(rawTokenId).toString()
  if (!account || !isAddress(account)) {
    return errorResponse(400, 'Invalid account')
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return errorResponse(400, 'Invalid txHash')
  }

  const collectionLower = collectionAddress.toLowerCase()

  const verified = await verifyMintOnChain(txHash as Hex, collectionLower, tokenId, account)
  if (!verified.ok) {
    // Loud trace for what was previously a silent 403. The client POSTs only
    // AFTER its own waitForTransactionReceipt, so a rejection here almost
    // always means the server's RPC hasn't indexed the tx yet (lag) — the
    // client now retries a few times to absorb that. A persistent failure is a
    // genuinely lost record (collected list, trending, Pass validity) and the
    // reconciliation script's job; without this log it left no trace at all.
    console.warn('[collect] mint verification failed', {
      txHash,
      collection: collectionLower,
      tokenId,
      account,
    })
    return errorResponse(403, 'Mint not verified on-chain')
  }

  // Collect-and-gift attribution. `account` above is already proved to be the
  // wallet the edition was minted to; this only resolves WHO PAID, for the
  // notifications. Accepted on either proof — the receipt's payer (plain EOA
  // collects) or the SIWE session (smart-wallet / ERC-4337 paths, where
  // receipt.from is the bundler) — and silently dropped otherwise, so a
  // spoofed claim degrades to a plain collect rather than fabricating a
  // notification from a wallet the caller doesn't control.
  //
  // NOTE the gift needs NO special handling below this point. A gift-mint is
  // a mint: the credit, the collected list, and the provenance rules all key
  // off the recipient, which the receipt already proved. That is the whole
  // safety argument for shipping gifting on Pass pieces (see lib/gift.ts).
  const sessionAddress = claimedGiftedBy ? await getSessionAddress(req).catch(() => null) : null
  const giftedBy = verifyGiftClaim({
    claimed: claimedGiftedBy,
    collector: account,
    receiptFrom: verified.from,
    sessionAddress,
  })

  // Blacklist gate on the GIFTER, mirroring /api/airdrop/notify. A gift is not
  // a collect: it hands a fresh, fully-valid credential to a wallet of the
  // gifter's choosing, which is the propagation the moderation lists exist to
  // stop. Collecting FOR YOURSELF while blacklisted stays allowed — that is
  // lib/blacklist's documented policy and this narrows nothing about it.
  //
  // Two lists, each for the case it was written for:
  //   - action blacklist — blocks creator actions incl. airdrop, the free
  //     analogue of this exact event. Applies to any collection.
  //   - PASS blacklist — "this identity must not have creator access". Buying
  //     Passes and gifting them to fresh wallets is a direct route around it,
  //     so it applies when the gift targets the Pass collection. Without this,
  //     a moderated identity could re-credential itself for the mint price.
  // The mint is already on-chain (the user signs it from their own wallet,
  // exactly like an airdrop), so this denies the platform-side record and
  // credit, not the movement of tokens — admin can still grant via
  // POST /api/admin/pass-validity if a denial turns out to be wrong.
  // The wallet whose moderation status decides this acquisition: the proven
  // claim, else the receipt payer when it differs from the recipient — the
  // fallback that keeps this gate from being opt-in (a hand-rolled POST just
  // omits `giftedBy`; the receipt proves who received, never who paid). Full
  // reasoning and the 4337-bundler carve-out live on lib/gift.moderationSubject;
  // deny-only — the notification below stays keyed on the PROVEN claim.
  const subject = moderationSubject({
    provenGifter: giftedBy,
    collector: account,
    receiptFrom: verified.from,
  })

  if (subject) {
    // getGateConfig never throws (last-known-good / cold-start fallback) and
    // is in-process cached, so this is effectively free here.
    const gate = await getGateConfig()
    const isPassGift = !!gate.passCollection && gate.passCollection === collectionLower
    const [actionBlocked, passBlocked] = await Promise.all([
      isBlacklisted(subject).catch(() => false),
      isPassGift ? isPassBlacklisted(subject).catch(() => false) : Promise.resolve(false),
    ])
    if (actionBlocked || passBlocked) {
      // Refusing to RECORD the gift does not deny it. processTransfer credits
      // `to` on any mint with no platform flag required, and the Alchemy
      // webhook usually arrives before this request — so the recipient is
      // already credited by the time we 403, and returning here would let a
      // moderated wallet hand out working creator access for the mint price.
      // Deny at READ time instead: mark the units against the recipient so
      // hasValidPass subtracts them whenever the gate is next consulted.
      // Ordering-independent, and reversible by admin via
      // DELETE /api/admin/taint if the denial turns out to be wrong.
      const denied = await denyUnsanctionedAcquisition({
        collection: collectionLower,
        address: account,
        txHash,
        tokenId,
        units: verified.units,
      })
      // Loud: the payer spent real money and the recipient holds an edition
      // that now proves nothing. An operator may still want to intervene.
      console.warn('[collect] gift denied — blacklisted gifter', {
        txHash,
        collection: collectionLower,
        tokenId,
        gifter: subject,
        claimed: giftedBy ?? null,
        recipient: account,
        actionBlocked,
        passBlocked,
        unitsDenied: denied ? verified.units : 0,
      })
      return errorResponse(403, 'Address is blocked from gifting')
    }
  }

  // Idempotency gate. SET NX returns 'OK' on first claim, null when the key
  // already exists. Distinguish those two cases from Redis-transient errors:
  //   - 'OK'  → proceed with the recording side effects.
  //   - null  → genuine idempotency hit; return 200 so legitimate retries
  //             from useCollectAll's Promise.all don't surface as errors.
  //   - throw → Redis is down or partitioned; we CAN'T enforce idempotency,
  //             so fail closed with a 503. The client logs the non-2xx via
  //             the new fetch wrapper; a follow-up retry once Redis recovers
  //             would land cleanly on this same tuple.
  // Conflating throws with "already recorded" was the prior behavior — that
  // silently swallowed mint-recording during Redis flakes.
  const idemKey = `kismetart:collect-idem:${txHash}:${collectionLower}:${tokenId}:${account}`
  let acquired: 'OK' | null
  try {
    // Upstash's SET-with-NX returns 'OK' | null at runtime; the wider type
    // in the SDK includes the value type for the GET option we're not using.
    acquired = (await redis.set(idemKey, '1', {
      nx: true,
      ex: IDEMPOTENCY_TTL_SECONDS,
    })) as 'OK' | null
  } catch (err) {
    console.error('[collect] idempotency-lock failed', { txHash, err })
    return errorResponse(503, 'Recording temporarily unavailable')
  }
  if (acquired !== 'OK') {
    return NextResponse.json({ ok: true, idempotent: true })
  }

  // Flag this tx as platform-originated so the Pass-transfer webhook credits
  // the collector with validity when the Transfer event arrives. The flag is
  // keyed by tx hash and only consulted by the webhook for Pass-collection
  // transfers — non-Pass collects just write an unused flag (cheap). Without
  // this, collecting a Pass from the gate-collection page wouldn't grant the
  // collector the validity their collect should earn, requiring a manual
  // /admin/pass grant. verifyMintOnChain already proved this is a real mint
  // of `tokenId` from `collectionLower` to `account`, so flagging is safe.
  after(() =>
    recordPlatformTx(txHash, [account], tokenId).catch(
      bestEffort('collect.recordPlatformTx', { txHash, collection: collectionLower, account }),
    ),
  )

  // Credit Pass validity SYNCHRONOUSLY here for a Pass-collection collect, using the
  // mint verifyMintOnChain already proved. The webhook above only credits when
  // recordPlatformTx's flag is already set as it processes the Transfer — but Alchemy
  // can deliver the on-chain event before this request even runs (the client calls
  // /api/collect only after the mint mines), so the webhook routinely sees no flag,
  // skips the credit, and claims its idempotency key so it never retries — the credit
  // is lost permanently and the collector is stuck behind the "collect from <name>" gate CTA.
  // Crediting directly here removes that race. creditValidityOnce is idempotent (same
  // keyCredited as the webhook), so whichever fires first wins and the other no-ops.
  // amount:1 — the gate only needs validBalance >= 1, the client's amount is untrusted,
  // and the webhook backstops the exact on-chain count. Best-effort: a failure here
  // leaves the webhook + flag as the fallback and never blocks the collect recording.
  try {
    const gate = await getGateConfig()
    if (gate.passCollection && gate.passCollection.toLowerCase() === collectionLower) {
      await creditValidityOnce({ collection: collectionLower, address: account, txHash, tokenId, amount: 1 })
    }
  } catch (err) {
    console.error('[collect] pass-validity direct-credit failed', { txHash, collection: collectionLower, err })
  }

  // Bound amount to a sane ceiling — collect-all hardcodes 1, useDirectCollect
  // accepts user input. 1000 is far above any plausible single-mint quantity
  // and prevents a malicious client from recording absurd notification counts.
  const safeAmount = Number.isFinite(amount) && amount > 0
    ? Math.min(Math.floor(amount), 1000)
    : 1

  await Promise.all([
    // Inline trim: keep the trending zset capped at top 10K alongside the
    // increment. Pattern: BullMQ-style write-side bounding, replaces the
    // per-5min trimTrending background task with a per-collect operation.
    // The trim is a no-op when the zset is under cap (cheap) and is
    // amortized across every collect event — vastly fewer than 288/day
    // background-task fires.
    // Latest-sales rides the same multi: zadd overwrites the member's score
    // with this collect's timestamp (last sale wins), trimmed identically.
    // Rank 0 is the LOWEST score in both zsets — fewest collects / oldest
    // sale — so both trims evict the least-feed-worthy members first.
    redis
      .multi()
      .zincrby(TRENDING_KEY, 1, `${collectionLower}:${tokenId}`)
      .zremrangebyrank(TRENDING_KEY, 0, -10_001)
      .zadd(TRENDING_LATEST_KEY, { score: Date.now(), member: `${collectionLower}:${tokenId}` })
      .zremrangebyrank(TRENDING_LATEST_KEY, 0, -10_001)
      .exec()
      .catch(() => {}),
    recordCollected(account, collectionLower, tokenId).catch(() => {}),
  ])

  // Derive price server-side so the notification reflects the on-chain
  // truth rather than whatever the client claimed. Fall back to the
  // S-1-validated client value on any RPC failure / unconfigured sale —
  // the client value is still bounded by the regex check so the worst-
  // case fallback is bounded misinformation, not unbounded.
  let derivedPrice: bigint | null = null
  if (currency) {
    derivedPrice = await readSalePricePerToken(
      serverBaseClient(),
      collectionLower as Address,
      BigInt(tokenId),
      currency,
    )
  }
  const finalPrice = derivedPrice !== null ? derivedPrice.toString() : pricePerToken

  after(async () => {
    try {
      const meta = await getMomentMeta(collectionLower, tokenId)

      // Recipient ping for a gift — "<gifter> gifted you <artwork>". Sent even
      // when the moment meta lookup misses (the copy falls back to "an
      // artwork"): a recipient who was just handed a Pass needs to know it
      // arrived, and unlike the creator notification there is no field here
      // that requires meta. Mirrors the airdropee notification, which is the
      // free analogue of this exact event.
      if (giftedBy) {
        await writeNotification({
          type: 'gift',
          recipient: account,
          actor: giftedBy,
          tokenAddress: collectionLower,
          tokenId,
          ...(meta?.name ? { tokenName: meta.name } : {}),
          amount: safeAmount,
        }).catch(() => {})
      }

      if (!meta) return
      await writeNotification({
        type: 'collect',
        recipient: meta.creator,
        // The PAYER is the collector from the creator's point of view — they
        // are who bought the edition. On a plain collect this is `account`
        // (giftedBy is null); on a gift it names the gifter rather than the
        // recipient, who did nothing.
        actor: giftedBy ?? account,
        tokenAddress: collectionLower,
        tokenId,
        tokenName: meta.name,
        amount: safeAmount,
        ...(finalPrice ? { price: finalPrice } : {}),
        ...(currency ? { currency } : {}),
        ...(comment && !isPlatformCollectComment(comment) ? { comment } : {}),
      })
    } catch {
      // notifications are non-critical
    }
  })

  return NextResponse.json({ ok: true })
}
