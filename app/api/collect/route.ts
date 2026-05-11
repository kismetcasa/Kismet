import { NextRequest, NextResponse } from 'next/server'
import { decodeEventLog, parseAbi, type Hex } from 'viem'
import { isAddress } from '@/lib/address'
import { DEFAULT_COLLECT_COMMENT } from '@/lib/inprocess'
import { redis } from '@/lib/redis'
import { checkRateLimit, getClientIp } from '@/lib/ratelimit'
import { getMomentMeta, writeNotification } from '@/lib/notifications'
import { serverBaseClient } from '@/lib/rpc'

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
// `collection`. Fail-closed: any RPC, decode, or no-match path returns false.
async function verifyMintOnChain(
  txHash: Hex,
  collection: string,
  tokenId: string,
  account: string,
): Promise<boolean> {
  const cacheKey = `verify:collect:${txHash}:${collection}:${tokenId}:${account}`
  const cached = await redis.get(cacheKey).catch(() => null)
  if (cached === '1') return true
  if (cached === '0') return false

  try {
    const receipt = await serverBaseClient().getTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      await redis.set(cacheKey, '0', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
      return false
    }

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
      const { from, to, id } = decoded.args
      if (
        from === '0x0000000000000000000000000000000000000000' &&
        to.toLowerCase() === account &&
        id === expectedTokenId
      ) {
        await redis.set(cacheKey, '1', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
        return true
      }
    }

    await redis.set(cacheKey, '0', { ex: VERIFY_CACHE_TTL_SECONDS }).catch(() => {})
    return false
  } catch {
    // RPC failure: don't cache (transient).
    return false
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
  if (!allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const body = (await req.json().catch(() => null)) as {
    moment?: { collectionAddress?: string; tokenId?: string }
    account?: string
    amount?: number
    comment?: string
    pricePerToken?: string
    currency?: 'eth' | 'usdc'
    txHash?: string
  } | null

  if (!body) return NextResponse.json({ error: 'Invalid body' }, { status: 400 })

  const collectionAddress = body.moment?.collectionAddress
  const tokenId = body.moment?.tokenId
  const account = body.account?.toLowerCase()
  const amount = Number(body.amount ?? 1)
  const comment = body.comment
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
    return NextResponse.json({ error: 'Invalid collectionAddress' }, { status: 400 })
  }
  if (!tokenId || !/^\d+$/.test(String(tokenId))) {
    return NextResponse.json({ error: 'Invalid tokenId' }, { status: 400 })
  }
  if (!account || !isAddress(account)) {
    return NextResponse.json({ error: 'Invalid account' }, { status: 400 })
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: 'Invalid txHash' }, { status: 400 })
  }

  const collectionLower = collectionAddress.toLowerCase()

  const verified = await verifyMintOnChain(txHash as Hex, collectionLower, tokenId, account)
  if (!verified) {
    return NextResponse.json(
      { error: 'Mint not verified on-chain' },
      { status: 403 },
    )
  }

  // Idempotency gate. SET NX returns null/false when the key already exists,
  // meaning this (tx, collection, token, account) tuple has already been
  // recorded — short-circuit so trending isn't double-incremented and the
  // creator isn't double-notified. Failure to acquire the lock here is
  // treated as "already recorded" rather than retried; the response stays a
  // 200 so clients (including legitimate retry paths in useCollectAll) don't
  // see this as an error worth surfacing.
  const idemKey = `kismetart:collect-idem:${txHash}:${collectionLower}:${tokenId}:${account}`
  const acquired = await redis
    .set(idemKey, '1', { nx: true, ex: IDEMPOTENCY_TTL_SECONDS })
    .catch(() => null)
  if (acquired !== 'OK') {
    return NextResponse.json({ ok: true, idempotent: true })
  }

  // Bound amount to a sane ceiling — collect-all hardcodes 1, useDirectCollect
  // accepts user input. 1000 is far above any plausible single-mint quantity
  // and prevents a malicious client from recording absurd notification counts.
  const safeAmount = Number.isFinite(amount) && amount > 0
    ? Math.min(Math.floor(amount), 1000)
    : 1

  await Promise.all([
    redis.zincrby('kismetart:trending', 1, `${collectionLower}:${tokenId}`).catch(() => {}),
    redis
      .zadd(`kismetart:collected:${account}`, {
        score: Date.now(),
        member: `${collectionLower}:${tokenId}`,
      })
      .catch(() => {}),
  ])

  // Notification is fire-and-forget — never let it gate the response.
  void (async () => {
    try {
      const meta = await getMomentMeta(collectionLower, tokenId)
      if (!meta) return
      await writeNotification({
        type: 'collect',
        recipient: meta.creator,
        actor: account,
        tokenAddress: collectionLower,
        tokenId,
        tokenName: meta.name,
        amount: safeAmount,
        ...(pricePerToken ? { price: pricePerToken } : {}),
        ...(currency ? { currency } : {}),
        ...(comment && comment !== DEFAULT_COLLECT_COMMENT ? { comment } : {}),
      })
    } catch {
      // notifications are non-critical
    }
  })()

  return NextResponse.json({ ok: true })
}
